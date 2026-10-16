"""Admin dashboard + admin API (everything the dashboard does is a plain HTTP call, so it can all be scripted).

Security model
  * Disabled (503) unless ADMIN_TOKEN is set. It is a different secret from VOICETUT_TOKEN (which only protects /tts for your Node server).
  * Browser: POST /admin/api/login {token} -> HttpOnly, SameSite=Strict cookie holding an HMAC-signed, expiring session. The token itself is never
    stored in the page or in the cookie. State-changing cookie requests must carry the header `X-Requested-With: egy-admin` (CSRF guard).
  * Scripts: `Authorization: Bearer <ADMIN_TOKEN>` on any /admin/api route.
  * Token compared in constant time; 5 wrong attempts per IP in 5 minutes -> 429 for the rest of the window.
  * Transport encryption is TLS, which Railway terminates for you (always use the https URL). The cookie is `Secure` behind https.
Every route is registered with its documentation (see `api()`), and /admin/docs + /admin/api/openapi.json are generated from that registry.
"""
import asyncio
import base64
import hashlib
import hmac
import html
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from urllib.parse import quote

from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from . import logbuf
from .config import secret_equal

REGISTRY = []                     # every documented endpoint
_routes = []                      # the admin ones, mounted by routes()
S = {}                            # runtime wiring from server.py: cfg, pipe, vt(), prewarm(), ref_dir, ref_paths
HERE = os.path.dirname(os.path.abspath(__file__))
CSRF_HEADER = ("x-requested-with", "egy-admin")
TOKEN_VAR = os.environ.get("ADMIN_TOKEN_VAR", "ADMIN_TOKEN")     # name shown in messages: the all-in-one image feeds this service from TTS_ADMIN_TOKEN

# ------------------------------------------------------------------------------------------------ settings schema
SETTINGS = {   # key: (type, min, max, description). Applied live; saved to SETTINGS_FILE; env var of the same name (see README) is the boot default.
    "SPEAKER": ("str", None, None, "Default VoiceTut speaker when the request names none"),
    "SPEED": ("float", 0.5, 2.0, "Speech speed multiplier"),
    "NUM_STEP": ("steps", 1, 128, "Diffusion steps: 'auto' (12 on CPU / 32 on GPU) or an integer. Lower = faster, rougher"),
    "GUIDANCE": ("float", 0.0, 10.0, "Classifier-free guidance scale"),
    "TIMEOUT_S": ("float", 1, 300, "Whole-request deadline; the preferred engine gets what is left, then a fallback answers"),
    "MAX_QUEUE": ("int", 1, 50, "Jobs allowed to wait on one engine before overflow goes to the next engine"),
    "COOLDOWN_S": ("float", 0, 600, "Seconds an engine is skipped after a failure or timeout (circuit breaker)"),
    "MIN_BUDGET_S": ("float", 0, 30, "Time left below which a non-final engine is not even started"),
    "MAX_CHARS": ("int", 20, 5000, "Longest text accepted per request"),
    "CHUNK_MAX": ("int", 40, 600, "Longest sentence chunk"),
    "CHUNK_MIN": ("int", 5, 200, "Shortest sentence chunk before it is merged with a neighbour"),
    "GAP_MS": ("int", 0, 1000, "Silence between sentence chunks"),
    "PAD_MS": ("int", 0, 500, "Silence kept around speech after trimming"),
    "KEEPALIVE_S": ("int", 0, 86400, "Idle seconds before a tiny keep-warm generation (0 = off)"),
    "EDGE_VOICE": ("str", None, None, "Edge neural voice, e.g. ar-EG-SalmaNeural or ar-EG-ShakirNeural"),
    "EDGE_RATE": ("rate", None, None, "Edge speaking rate like +10% or -15%"),
    "ESPEAK_VOICE": ("str", None, None, "espeak-ng voice (ar)"),
    "LOG_TEXT": ("bool", None, None, "Keep the first 60 characters of each request in the log"),
}
_DEFAULTS = {}


def _coerce(key, v):
    t, lo, hi, _ = SETTINGS[key]
    if t == "bool":
        if isinstance(v, bool): return v
        if str(v).lower() in ("1", "true", "yes", "on"): return True
        if str(v).lower() in ("0", "false", "no", "off"): return False
        raise ValueError("expected true/false")
    if t == "steps":
        if str(v).lower() == "auto": return "auto"
        t = "int"
    if t == "rate":
        import re
        if not re.fullmatch(r"[+-]\d{1,3}%", str(v)): raise ValueError("expected like +10% or -15%")
        return str(v)
    if t in ("int", "float"):
        if isinstance(v, bool): raise ValueError("expected a number")
        x = int(v) if t == "int" else float(v)
        if t == "int" and float(v) != x: raise ValueError("expected an integer")
        if (lo is not None and x < lo) or (hi is not None and x > hi):
            raise ValueError(f"must be between {lo} and {hi}")
        return x
    s = str(v).strip()
    if not s or len(s) > 80: raise ValueError("expected a short non-empty string")
    return s


def settings_view(cfg):
    out = {}
    for k, (t, lo, hi, d) in SETTINGS.items():
        out[k] = {"value": getattr(cfg, k), "default": _DEFAULTS.get(k), "type": t, "min": lo, "max": hi, "description": d,
                  "overridden": getattr(cfg, k) != _DEFAULTS.get(k)}
    return out


def apply_settings(cfg, patch):
    """Validate everything first, then apply: all or nothing. Returns (applied, errors)."""
    clean, errors = {}, {}
    for k, v in (patch or {}).items():
        if k not in SETTINGS: errors[k] = "unknown setting"; continue
        try: clean[k] = _coerce(k, v)
        except (ValueError, TypeError) as e: errors[k] = str(e)
    if errors: return {}, errors
    for k, v in clean.items(): setattr(cfg, k, v)
    return clean, {}


# ------------------------------------------------------------------------------------------------ persistence
def _write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f: json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def save_state():
    cfg, pipe = S["cfg"], S["pipe"]
    over = {k: getattr(cfg, k) for k in SETTINGS if getattr(cfg, k) != _DEFAULTS.get(k)}
    state = {"settings": over, "engines": {"order": [s.engine.name for s in pipe.slots], "disabled": [s.engine.name for s in pipe.slots if not s.enabled]}}
    try: _write_json(cfg.SETTINGS_FILE, state)
    except OSError as e: pipe.event("warn", f"could not save settings: {e}")


def load_state(cfg, pipe):
    """Boot: remember env defaults, then lay saved overrides on top."""
    S.update(cfg=cfg, pipe=pipe)
    for k in SETTINGS: _DEFAULTS[k] = getattr(cfg, k)
    try:
        with open(cfg.SETTINGS_FILE, encoding="utf-8") as f: st = json.load(f)
    except (OSError, ValueError):
        return
    applied, errors = apply_settings(cfg, st.get("settings", {}))
    eng = st.get("engines", {})
    if eng.get("order"): pipe.set_order(eng["order"])
    for s in pipe.slots:
        if s.engine.name in eng.get("disabled", []): s.enabled = False
        elif s.engine.name in eng.get("order", []): s.enabled = True
    pipe.event("boot", f"loaded saved settings ({len(applied)} overrides)")


def phrases_path(cfg):
    return cfg.PHRASES_FILE or os.path.join(os.path.dirname(cfg.SETTINGS_FILE) or ".", "phrases.txt")


def read_phrases(cfg):
    for p in (phrases_path(cfg), os.path.join(HERE, "phrases.txt")):
        try:
            with open(p, encoding="utf-8") as f: return f.read()
        except OSError: continue
    return ""


# ------------------------------------------------------------------------------------------------ auth
_fail = defaultdict(list)


def _key(): return hashlib.sha256(b"egy-admin-session|" + S["cfg"].ADMIN_TOKEN.encode()).digest()     # rotating ADMIN_TOKEN kills every session


def _b64(b): return base64.urlsafe_b64encode(b).decode().rstrip("=")
def _unb64(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_session():
    payload = _b64(json.dumps({"exp": int(time.time() + S["cfg"].ADMIN_SESSION_HOURS * 3600), "n": _b64(os.urandom(8))}).encode())
    return payload + "." + _b64(hmac.new(_key(), payload.encode(), hashlib.sha256).digest())


def check_session(value):
    try:
        payload, sig = value.split(".", 1)
        if not hmac.compare_digest(_b64(hmac.new(_key(), payload.encode(), hashlib.sha256).digest()), sig): return False
        return json.loads(_unb64(payload))["exp"] > time.time()
    except Exception:
        return False


def token_ok(candidate):
    return secret_equal(candidate, S["cfg"].ADMIN_TOKEN)         # any length, constant time, trimmed the same way as the env value


def _ip(req): return (req.headers.get("x-forwarded-for", "").split(",")[0].strip() or (req.client.host if req.client else "?"))


def authorize(req):
    """Returns None when allowed, else a ready error Response."""
    if not S["cfg"].ADMIN_TOKEN:
        return JSONResponse({"error": f"admin disabled: set the {TOKEN_VAR} environment variable"}, status_code=503)
    h = req.headers.get("authorization", "")
    if h[:7].lower() == "bearer ":
        ip, now = _ip(req), time.time()                          # same lockout as the login form: a script cannot guess the token either
        _fail[ip] = [t for t in _fail[ip] if now - t < 300]
        if len(_fail[ip]) >= 5: return JSONResponse({"error": "too many attempts, wait 5 minutes"}, status_code=429)
        if token_ok(h[7:]):
            _fail.pop(ip, None); return None
        _fail[ip].append(now)
        return JSONResponse({"error": "bad token"}, status_code=401)
    if check_session(req.cookies.get("egy_admin", "")):
        if req.method not in ("GET", "HEAD") and req.headers.get(CSRF_HEADER[0]) != CSRF_HEADER[1]:
            return JSONResponse({"error": "missing X-Requested-With: egy-admin header"}, status_code=403)
        return None
    return JSONResponse({"error": "not logged in", "login": "/admin"}, status_code=401)


# ------------------------------------------------------------------------------------------------ route registry + docs
def api(method, path, summary, body=None, returns="JSON", tag="General", auth="admin", public=False):
    """Register an admin endpoint together with its documentation. path is relative to /admin/api."""
    def deco(fn):
        full = "/admin/api" + path
        REGISTRY.append(dict(method=method, path=full, summary=summary, body=body, returns=returns, tag=tag, auth=auth))
        async def wrapped(req: Request):
            if auth == "admin":
                denied = authorize(req)
                if denied: return denied
            try:
                return await fn(req)
            except Exception as e:
                return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=500)
        _routes.append(Route(full, wrapped, methods=[method]))
        return fn
    return deco


def doc_only(method, path, summary, body=None, returns="JSON", tag="Voice service", auth="service token"):
    REGISTRY.append(dict(method=method, path=path, summary=summary, body=body, returns=returns, tag=tag, auth=auth))


doc_only("POST", "/admin/api/login", "Browser login: {token} -> sets the signed HttpOnly session cookie (5 wrong tries per 5 min per IP, then 429)", body={"token": "<ADMIN_TOKEN>"}, tag="Auth", auth="none")
doc_only("POST", "/admin/api/logout", "Clear the session cookie", tag="Auth", auth="none")
doc_only("GET", "/admin/api/probe", "{enabled, authenticated}: lets the login page decide what to show", tag="Auth", auth="none")
doc_only("GET", "/health", "Is any engine able to speak right now (no auth)", auth="none")
doc_only("GET", "/ready", "200 only when the preferred engine is loaded, else 503", auth="none")
doc_only("POST", "/tts", "Text to speech. Returns 16-bit mono WAV; headers X-Duration-Ms, X-Engine, X-Cache-Hits, X-Took-Ms",
         body={"text": "عندي meeting بكرة الساعة 3:30", "speaker": "Mohamed", "speed": 1.0, "num_step": 12, "cache": True}, returns="audio/wav")
doc_only("GET", "/speakers", "Available VoiceTut speakers")
doc_only("PUT", "/ref/{id}", "Store a voice-clone reference (needs the speaker's consent)", body={"audio_b64": "<wav>", "text": "what is said in the recording"})
doc_only("POST", "/prep", "Show the exact string an engine would receive", body={"text": "ماذا تريد 50%", "keep_latin": True})
doc_only("GET", "/metrics", "Counters per engine, cache hit rate, RTF")
ENV_DOCS = [
    ("ADMIN_TOKEN", "Enables /admin and the admin API. Different from VOICETUT_TOKEN. Use a long random string (e.g. openssl rand -hex 32)."),
    ("VOICETUT_TOKEN", "Bearer token your Node stream server sends to /tts. Keep identical to the Node side."),
    ("ADMIN_SESSION_HOURS", "Dashboard login lifetime (default 12)."),
    ("SETTINGS_FILE / PHRASES_FILE", "Where dashboard overrides and the editable phrase list persist. Point them at the Railway volume, e.g. /data/settings.json."),
    ("STREAM_URL / STREAM_ADMIN_TOKEN", "Your Node stream server and its ADMIN_TOKEN: lets this dashboard read/drive its voice, speech pause/resume and state."),
    ("ENGINES", "Initial engine order, comma separated: voicetut,edge,espeak (fake for tests). Unlisted real engines start disabled; change live in the dashboard."),
    ("CACHE_DATABASE_URL (or DATABASE_URL) / CACHE_DB_MB / CACHE_DB", "Keep the audio cache in a database (postgres:// or sqlite:///file.db) instead of files. CACHE_DB=off ignores the URL."),
    ("CACHE_DIR / CACHE_MEM_MB / CACHE_DISK_MB", "File cache location and size limits (used when no database URL is set)."),
    ("TORCH_THREADS", "CPU threads for the model (match your Railway vCPUs)."),
    ("WARMUP / PREWARM", "Load the model at boot / pre-render the phrase list while idle (1 or 0)."),
    ("PORT", "Listening port (Railway sets it)."),
] + [(k, f"{v[3]} (live-editable in the dashboard)") for k, v in SETTINGS.items() if k in ("SPEAKER", "NUM_STEP", "TIMEOUT_S", "MAX_QUEUE", "KEEPALIVE_S")]


def openapi():
    paths = {}
    for r in REGISTRY:
        op = {"summary": r["summary"], "tags": [r["tag"]], "responses": {"200": {"description": r["returns"]}}}
        if r["auth"] != "none": op["security"] = [{"bearer": []}]
        if r["body"] is not None:
            op["requestBody"] = {"content": {"application/json": {"schema": {"type": "object", "example": r["body"]}}}}
        paths.setdefault(r["path"], {})[r["method"].lower()] = op
    return {"openapi": "3.0.3", "info": {"title": "Egyptian TTS service", "version": "1.0",
            "description": "Admin routes accept the dashboard cookie or `Authorization: Bearer $ADMIN_TOKEN`. Service routes accept `Bearer $VOICETUT_TOKEN`."},
            "components": {"securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}}}, "paths": paths}


def docs_html():
    esc = html.escape
    rows, tags = [], []
    for r in REGISTRY:
        if r["tag"] not in tags: tags.append(r["tag"])
    for tag in tags:
        rows.append(f"<h2>{esc(tag)}</h2>")
        for r in [x for x in REGISTRY if x["tag"] == tag]:
            tok = "$ADMIN_TOKEN" if r["path"].startswith("/admin/api") else "$VOICETUT_TOKEN"
            curl = f'curl -X {r["method"]} "$URL{r["path"]}"'
            if r["auth"] != "none": curl += f' -H "Authorization: Bearer {tok}"'
            if r["body"] is not None: curl += " -H 'Content-Type: application/json' -d '" + json.dumps(r["body"], ensure_ascii=False) + "'"
            rows.append(f'<div class="ep"><div><b class="m {r["method"]}">{r["method"]}</b> <code>{esc(r["path"])}</code> <span class="au">{esc(r["auth"])}</span></div>'
                        f'<p>{esc(r["summary"])}</p><pre>{esc(curl)}</pre><small>returns {esc(r["returns"])}</small></div>')
    env = "".join(f"<tr><td><code>{esc(k)}</code></td><td>{esc(v)}</td></tr>" for k, v in ENV_DOCS)
    return f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>TTS admin API</title>
<style>:root{{color-scheme:light dark;--bg:#fff;--fg:#17181c;--mut:#6b7280;--bd:#e5e7eb;--ac:#b45309}}@media(prefers-color-scheme:dark){{:root{{--bg:#111318;--fg:#e8e9ec;--mut:#9aa0ab;--bd:#2a2d36;--ac:#f59e0b}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:20px 16px;max-width:900px;margin-inline:auto}}h1{{font-size:22px}}h2{{margin-top:32px;border-bottom:1px solid var(--bd);padding-bottom:4px;font-size:17px}}
.ep{{border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin:10px 0}}.ep p{{margin:6px 0}}pre{{overflow:auto;background:rgba(127,127,127,.12);padding:8px;border-radius:6px;font-size:12.5px;margin:6px 0}}
.m{{display:inline-block;min-width:52px;text-align:center;border-radius:4px;color:#fff;background:#2563eb;font-size:12px;padding:1px 6px}}.m.POST{{background:#15803d}}.m.PUT,.m.PATCH{{background:#b45309}}.m.DELETE{{background:#b91c1c}}
.au{{float:right;font-size:12px;color:var(--mut)}}small{{color:var(--mut)}}table{{border-collapse:collapse;width:100%}}td{{border-top:1px solid var(--bd);padding:6px 4px;vertical-align:top}}a{{color:var(--ac)}}</style>
<h1>Egyptian TTS: API &amp; operations</h1><p><a href="/admin">&larr; dashboard</a> · <a href="/admin/api/openapi.json">openapi.json</a></p>
<p>Set <code>URL</code> to this service, e.g. <code>export URL=https://your-service.up.railway.app ADMIN_TOKEN=...</code>. Everything the dashboard does is one of these calls.</p>
{''.join(rows)}<h2>Environment variables</h2><table>{env}</table>"""


# ------------------------------------------------------------------------------------------------ helpers
def _sysinfo(cfg):
    info = {"cpus": os.cpu_count(), "python": sys.version.split()[0]}
    try: info["load"] = [round(x, 2) for x in os.getloadavg()]
    except OSError: pass
    t = sys.modules.get("torch")
    if t is not None: info["torch"] = getattr(t, "__version__", "?"); info["torch_threads"] = t.get_num_threads()
    def rd(p):
        try:
            with open(p) as f: return f.read().strip()
        except OSError: return None
    for line in (rd("/proc/self/status") or "").splitlines():
        if line.startswith("VmRSS"): info["rss_mb"] = round(int(line.split()[1]) / 1024)
    lim, cur = rd("/sys/fs/cgroup/memory.max"), rd("/sys/fs/cgroup/memory.current")
    if lim and lim.isdigit(): info["mem_limit_mb"] = round(int(lim) / 1048576)
    if cur and cur.isdigit(): info["mem_used_mb"] = round(int(cur) / 1048576)
    try:
        d = cfg.CACHE_DIR if not cfg.CACHE_DB_URL else "/tmp"; os.makedirs(d, exist_ok=True); du = shutil.disk_usage(d)
        info["disk_free_mb"] = round(du.free / 1048576)
        if not cfg.CACHE_DB_URL: info["cache_disk_mb"] = round(sum(e.stat().st_size for e in os.scandir(d) if e.is_file()) / 1048576, 1)
    except OSError: pass
    return info


def _stream(method, path, body=None, timeout=10):
    cfg = S["cfg"]
    if not cfg.STREAM_URL: return 503, {"error": "STREAM_URL is not set"}
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(cfg.STREAM_URL + path, data=data, method=method, headers={
        "Content-Type": "application/json", **({"Authorization": "Bearer " + cfg.STREAM_ADMIN_TOKEN} if cfg.STREAM_ADMIN_TOKEN else {})})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            try: return resp.status, json.loads(raw)
            except ValueError: return resp.status, {"text": raw.decode("utf-8", "replace")[:2000]}
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode("utf-8", "replace")[:300]}
    except Exception as e:
        return 502, {"error": f"{type(e).__name__}: {e}"}


async def _body(req):
    try:
        b = await req.json()
        return b if isinstance(b, dict) else {}
    except Exception:
        return {}


def _slot_or_404(name):
    s = S["pipe"].slot(name)
    return s


# ------------------------------------------------------------------------------------------------ endpoints
async def login(req: Request):
    cfg = S["cfg"]
    if not cfg.ADMIN_TOKEN:
        return JSONResponse({"error": f"admin disabled: set the {TOKEN_VAR} environment variable"}, status_code=503)
    ip, now = _ip(req), time.time()
    _fail[ip] = [t for t in _fail[ip] if now - t < 300]
    if len(_fail[ip]) >= 5:
        return JSONResponse({"error": "too many attempts, wait 5 minutes"}, status_code=429)
    b = await _body(req)
    if not token_ok(b.get("token", "")):
        _fail[ip].append(now); S["pipe"].event("auth", f"failed admin login from {ip}")
        await asyncio.sleep(0.4)
        return JSONResponse({"error": "wrong token"}, status_code=401)
    _fail.pop(ip, None)
    r = JSONResponse({"ok": True})
    secure = req.headers.get("x-forwarded-proto", req.url.scheme) == "https"
    r.set_cookie("egy_admin", make_session(), max_age=int(cfg.ADMIN_SESSION_HOURS * 3600), httponly=True, samesite="strict", secure=secure, path="/admin")
    S["pipe"].event("auth", f"admin login from {ip}")
    return r


async def logout(req: Request):
    r = JSONResponse({"ok": True}); r.delete_cookie("egy_admin", path="/admin"); return r


@api("GET", "/session", "Am I logged in (cookie or bearer)? Also says whether admin is enabled", tag="Auth")
async def session(req): return JSONResponse({"ok": True, "stream_configured": bool(S["cfg"].STREAM_URL)})


async def session_probe(req: Request):          # public: lets the login page decide what to show
    if not S["cfg"].ADMIN_TOKEN: return JSONResponse({"enabled": False, "token_var": TOKEN_VAR})
    return JSONResponse({"enabled": True, "authenticated": authorize(req) is None})


@api("GET", "/status", "Everything at a glance: engines, health, settings, cache, totals, system", tag="Status")
async def status(req):
    cfg, pipe = S["cfg"], S["pipe"]
    m = pipe.metrics()
    vt = pipe.slot("voicetut")
    return JSONResponse({"now": int(time.time()), "uptime_s": m["uptime_s"], "totals": m["totals"], "cache": m["cache"], "engines": m["engines"],
                         "order": [s.engine.name for s in pipe.slots], "voicetut": vt.engine.info() if vt and vt.enabled else None,
                         "system": await asyncio.to_thread(_sysinfo, cfg), "stream_configured": bool(cfg.STREAM_URL),
                         "idle_s": int(pipe.idle_for()), "busy": pipe.busy()})


@api("GET", "/settings", "All live-editable settings with defaults, limits and which are overridden", tag="Settings")
async def get_settings(req): return JSONResponse(settings_view(S["cfg"]))


@api("PATCH", "/settings", "Change settings live (validated, all-or-nothing, saved to SETTINGS_FILE)", body={"NUM_STEP": 8, "SPEED": 1.05}, tag="Settings")
async def patch_settings(req):
    applied, errors = apply_settings(S["cfg"], await _body(req))
    if errors: return JSONResponse({"errors": errors}, status_code=400)
    save_state(); S["pipe"].event("config", "settings changed: " + ", ".join(f"{k}={v}" for k, v in applied.items()))
    return JSONResponse({"applied": applied})


@api("POST", "/settings/reset", "Drop all overrides: back to environment-variable defaults", tag="Settings")
async def reset_settings(req):
    for k, v in _DEFAULTS.items(): setattr(S["cfg"], k, v)
    save_state(); S["pipe"].event("config", "settings reset to defaults")
    return JSONResponse({"ok": True})


@api("GET", "/engines", "Engines in priority order with state, counters, last error", tag="Engines")
async def engines(req): return JSONResponse(S["pipe"].metrics()["engines"])


@api("PUT", "/engines/order", "Set engine priority (first enabled engine is preferred)", body={"order": ["voicetut", "edge", "espeak"]}, tag="Engines")
async def engines_order(req):
    names = (await _body(req)).get("order")
    known = [s.engine.name for s in S["pipe"].slots]
    if not isinstance(names, list) or not names or any(n not in known for n in names):
        return JSONResponse({"error": f"order must list known engines: {known}"}, status_code=400)
    S["pipe"].set_order(names); save_state(); S["pipe"].event("config", "engine order: " + ",".join(names))
    return JSONResponse({"order": [s.engine.name for s in S["pipe"].slots]})


@api("POST", "/engines/{name}/{action}", "action = enable | disable | reset (close the circuit breaker) | reload (drop and reload the model, voicetut only)", tag="Engines")
async def engine_action(req):
    name, action = req.path_params["name"], req.path_params["action"]
    pipe = S["pipe"]; slot = pipe.slot(name)
    if not slot: return JSONResponse({"error": "unknown engine"}, status_code=404)
    if action in ("enable", "disable"):
        slot.enabled = action == "enable"
        if not any(s.enabled for s in pipe.slots): slot.enabled = True; return JSONResponse({"error": "at least one engine must stay enabled"}, status_code=400)
        save_state()
    elif action == "reset":
        slot.down_until = 0.0; slot.last_error = ""
    elif action == "reload":
        if name != "voicetut": return JSONResponse({"error": "only voicetut has a model to reload"}, status_code=400)
        slot.engine.reset()
        async def bg():
            try: await asyncio.to_thread(slot.engine.load)
            except Exception: pass
        asyncio.create_task(bg())
    else:
        return JSONResponse({"error": "unknown action"}, status_code=400)
    pipe.event("engine", f"{name}: {action}")
    return JSONResponse({"ok": True, "engine": name, "action": action, "enabled": slot.enabled})


@api("GET", "/cache", "Cache statistics", tag="Cache")
async def cache_stats(req): return JSONResponse(S["pipe"].cache.stats())


@api("DELETE", "/cache", "Clear the memory cache and the persistent store (database table or cache directory)", tag="Cache")
async def cache_clear(req):
    n = await asyncio.to_thread(S["pipe"].cache.clear)
    S["pipe"].event("cache", f"cleared ({n} stored entries)")
    return JSONResponse({"ok": True, "files_removed": n, "entries_removed": n})


@api("GET", "/phrases", "The pre-render phrase list (one per line, # for comments)", returns="{text}", tag="Cache")
async def get_phrases(req): return JSONResponse({"text": read_phrases(S["cfg"]), "path": phrases_path(S["cfg"])})


@api("PUT", "/phrases", "Replace the phrase list (saved to PHRASES_FILE)", body={"text": "أهلا بيكم\nتمام"}, tag="Cache")
async def put_phrases(req):
    text = str((await _body(req)).get("text", ""))[:20000]
    p = phrases_path(S["cfg"]); os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "w", encoding="utf-8") as f: f.write(text)
    return JSONResponse({"ok": True, "lines": len([l for l in text.splitlines() if l.strip() and not l.startswith("#")])})


@api("POST", "/cache/prewarm", "Start pre-rendering the phrase list now (runs while idle)", tag="Cache")
async def prewarm(req):
    started = S["prewarm"]()
    return JSONResponse({"started": started})


@api("GET", "/requests", "Recent /tts requests (newest first): text start, engines, cache hits, timings, errors. ?limit=50", tag="Activity")
async def requests_log(req):
    n = max(1, min(300, int(req.query_params.get("limit", 50))))
    return JSONResponse(list(S["pipe"].log)[:n])


@api("GET", "/events", "Engine failures, timeouts, setting changes, logins (newest first)", tag="Activity")
async def events(req): return JSONResponse(list(S["pipe"].events)[:100])


def _log_args(req):
    q = req.query_params
    def num(k, d):
        try: return int(q.get(k, d))
        except ValueError: return d
    lvl = q.get("level", "debug")
    return num("since", 0), (lvl if lvl in logbuf.LEVELS else "debug"), num("limit", 300)


@api("GET", "/logs", "This service's log lines, oldest first. ?since=<id> returns only newer lines, ?level=debug|info|warn|error (minimum), ?limit=300. "
     "Response {service, boot, next, items:[{id,t(ms),level,src,msg}]}; `boot` changes on restart (ids then start over). Secrets are redacted.", tag="Activity")
async def logs(req):
    return JSONResponse(logbuf.read(*_log_args(req)))


@api("GET", "/stream/logs", "Stream server (Node): its log lines, same query and response shape as /logs (proxy to its /logs)", tag="Stream server (publish/view)")
async def stream_logs(req):
    since, level, limit = _log_args(req)
    code, j = await asyncio.to_thread(_stream, "GET", f"/logs?since={since}&level={level}&limit={limit}")
    if code in (401, 403):             # never pass the Node server's 401 through: the dashboard would read it as "you are signed out"
        return JSONResponse({"error": "stream server rejected STREAM_ADMIN_TOKEN (must equal the Node server's ADMIN_TOKEN)"}, status_code=502)
    return JSONResponse(j, status_code=code)


@api("POST", "/test", "Speak a test line through the real pipeline (cache and fallbacks included). Returns WAV", returns="audio/wav", tag="Test",
     body={"text": "أهلا بيكم في اللايف", "speaker": "Mohamed", "cache": False})
async def test_speak(req):
    b = await _body(req)
    try:
        r = await S["pipe"].synthesize(str(b.get("text", "")), speaker=b.get("speaker"), speed=b.get("speed"), num_step=b.get("num_step"),
                                       use_cache=b.get("cache", True) is not False, timeout_s=b.get("timeout_s"))
    except ValueError as e: return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e: return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=503)
    return Response(r.wav, media_type="audio/wav", headers={
        "X-Duration-Ms": str(r.duration_ms), "X-Engine": ",".join(dict.fromkeys(r.engines)), "X-Cache-Hits": f"{r.cache_hits}/{r.chunks}",
        "X-Took-Ms": str(r.took_ms), "X-Spoken": quote(r.spoken), "Cache-Control": "no-store"})


@api("POST", "/prep", "Show the Egyptian text prep result: spoken string, sentence chunks, egyptianized wording", body={"text": "ماذا أريد الآن 3:30"}, tag="Test")
async def prep_preview(req):
    from . import prep as _prep
    from .pipeline import split_sentences
    t = str((await _body(req)).get("text", "")); cfg = S["cfg"]
    sp = _prep.prepare_speech(t, True)
    return JSONResponse({"spoken": sp, "chunks": split_sentences(sp, cfg.CHUNK_MAX, cfg.CHUNK_MIN), "egyptianized": _prep.egyptianize(t),
                         "arabized_for_edge": _prep.prepare_speech(t, False)})


@api("GET", "/speakers", "Speaker list the model reports", tag="Test")
async def speakers_list(req):
    vt = S["vt"]()
    return JSONResponse(await asyncio.to_thread(vt.speakers) if vt else [])


@api("GET", "/refs", "Stored voice-clone references (ids and sizes)", tag="Voices")
async def refs(req):
    d, out = S["cfg"].REF_DIR, []
    try:
        for e in os.scandir(d):
            if e.name.endswith(".wav"):
                txt = ""
                try: txt = open(e.path[:-4] + ".txt", encoding="utf-8").read()[:80]
                except OSError: pass
                out.append({"id": e.name[:-4], "kb": round(e.stat().st_size / 1024), "text": txt, "age_h": round((time.time() - e.stat().st_mtime) / 3600, 1)})
    except OSError: pass
    return JSONResponse(out)


@api("DELETE", "/refs/{id}", "Delete a stored voice-clone reference", tag="Voices")
async def refs_delete(req):
    rid = req.path_params["id"]
    if not S["ref_ok"](rid): return JSONResponse({"error": "bad id"}, status_code=400)
    n = 0
    for p in S["ref_paths"](rid):
        try: os.unlink(p); n += 1
        except OSError: pass
    return JSONResponse({"removed": n})


@api("GET", "/stream/voices", "Stream server: current voice, speakers, whether the voice service is up (proxy to its /voices)", tag="Stream server (publish/view)")
async def stream_voices(req):
    code, j = await asyncio.to_thread(_stream, "GET", "/voices"); return JSONResponse(j, status_code=code)


@api("GET", "/stream/selftest", "Stream server: one real generation through the voice service with timing (its /voices/test)", tag="Stream server (publish/view)")
async def stream_selftest(req):
    code, j = await asyncio.to_thread(_stream, "GET", "/voices/test", None, 130); return JSONResponse(j, status_code=code)


@api("POST", "/stream/voice", "Stream server: choose the live voice (vt = VoiceTut speaker name; en/ar = Edge voice ids)", body={"vt": "Asmaa"}, tag="Stream server (publish/view)")
async def stream_voice(req):
    b = await _body(req); b = {k: v for k, v in b.items() if k in ("vt", "en", "ar") and isinstance(v, str)}
    code, j = await asyncio.to_thread(_stream, "POST", "/voice", b); return JSONResponse(j, status_code=code)


@api("POST", "/stream/speech/{action}", "Stream server: pause or resume speech (action = pause | resume)", tag="Stream server (publish/view)")
async def stream_speech(req):
    a = req.path_params["action"]
    if a not in ("pause", "resume"): return JSONResponse({"error": "action must be pause or resume"}, status_code=400)
    code, j = await asyncio.to_thread(_stream, "POST", "/speech/" + a, {}); return JSONResponse(j, status_code=code)


@api("GET", "/stream/state", "Stream server: its live state (proxy to /state)", tag="Stream server (publish/view)")
async def stream_state(req):
    code, j = await asyncio.to_thread(_stream, "GET", "/state"); return JSONResponse(j, status_code=code)


@api("GET", "/openapi.json", "OpenAPI description of every endpoint (generated from the same registry as /admin/docs)", tag="Auth")
async def openapi_json(req): return JSONResponse(openapi())


async def docs(req: Request):
    denied = authorize(req)
    return denied if denied else HTMLResponse(docs_html())


async def dashboard(req: Request):
    with open(os.path.join(HERE, "admin_ui.html"), encoding="utf-8") as f:
        return HTMLResponse(f.read(), headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
                                                "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:"})


def routes():
    return [Route("/admin", dashboard), Route("/admin/docs", docs), Route("/admin/api/login", login, methods=["POST"]),
            Route("/admin/api/logout", logout, methods=["POST"]), Route("/admin/api/probe", session_probe)] + _routes
