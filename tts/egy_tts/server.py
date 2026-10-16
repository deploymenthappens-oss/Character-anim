"""HTTP service. Drop-in replacement for voicetut/app.py as seen by chat/voicetut.js (same routes, same headers),
plus /prep, /metrics and /ready.   Run:  uvicorn egy_tts.server:app --host 0.0.0.0 --port ${PORT:-8000}

  GET  /health            {ok, loaded, error, device, repo, speaker, ...}   (ok = some engine can speak now; no auth)
  GET  /ready             200 when the preferred engine is loaded, else 503  (use for a strict readiness probe)
  GET  /speakers          [{name, gender, tags}]
  PUT  /ref/{id}          {audio_b64, text}     store a voice-clone reference (needs consent of the speaker)
  POST /tts               {text, speaker?, speed?, num_step?, guidance_scale?, ref_id?, cache?: bool, prepare?: bool}
                          -> audio/wav 16-bit mono; headers X-Duration-Ms X-Sample-Rate X-Trim-Lead-Ms X-Engine X-Cache-Hits X-Chunks X-Took-Ms
  POST /prep              {text, keep_latin?} -> the exact string the engine would receive (debug the Egyptian text prep)
  GET  /admin             dashboard (needs ADMIN_TOKEN);  /admin/docs  API docs;  /admin/api/*  everything the dashboard does
  GET  /metrics           counters per engine, cache hit rate, real-time factor (the numbers for unit economics)
"""
import asyncio
import base64
import contextlib
import os
import re

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import admin, prep
from .config import Config, secret_equal
from .engines import CARD_SPEAKERS, FEMALE, EngineError
from .logbuf import log
from .pipeline import Pipeline

cfg = Config()
pipe = Pipeline(cfg)
REF_ID_RE = re.compile(r"^[a-f0-9]{8,64}$")
os.makedirs(cfg.REF_DIR, exist_ok=True)


def _ref_paths(ref_id): return os.path.join(cfg.REF_DIR, ref_id + ".wav"), os.path.join(cfg.REF_DIR, ref_id + ".txt")
def _err(msg, code): return JSONResponse({"error": msg}, status_code=code)


def _denied(req: Request):
    if not cfg.TOKEN: return False                                      # no VOICETUT_TOKEN set = open (as before)
    h = req.headers.get("authorization", "")
    return not (h[:7].lower() == "bearer " and secret_equal(h[7:], cfg.TOKEN))


def _primary_vt():
    e = pipe.primary.engine
    return e if e.name == "voicetut" else None


def _vt():
    """The VoiceTut engine if its slot is enabled (independent of priority order)."""
    sl = pipe.slot("voicetut")
    return sl.engine if sl and sl.enabled else None


# ------------------------------------------------------------------ routes
async def health(req):
    p, vt, chain = pipe.primary, _primary_vt(), pipe.chain()
    primary_ok = p.engine.available() and (vt.loaded if vt else True)
    fallback_ok = any(s.engine.available() for s in chain[1:])
    ok = primary_ok or (not p.engine.available() and fallback_ok)      # loading: not ok yet (callers wait); load failed: ok via fallback
    return JSONResponse({"ok": ok, "loaded": bool(vt.loaded) if vt else None, "error": getattr(vt, "load_error", None),
                         "device": getattr(vt, "device", None), "repo": cfg.REPO, "speaker": cfg.SPEAKER,
                         "engines": [s.engine.name for s in chain if s.engine.available()]})


async def ready(req):
    vt = _primary_vt()
    good = vt.loaded if vt else pipe.primary.engine.available()
    return JSONResponse({"ready": good}, status_code=200 if good else 503)


async def speakers(req):
    if _denied(req): return _err("bad token", 401)
    vt = _primary_vt()
    return JSONResponse(await asyncio.to_thread(vt.speakers) if vt else [{"name": n, "gender": "female" if n in FEMALE else "male", "tags": []} for n in CARD_SPEAKERS])


async def put_ref(req):
    if _denied(req): return _err("bad token", 401)
    ref_id = req.path_params["ref_id"]
    if not REF_ID_RE.match(ref_id): return _err("bad ref id", 400)
    try:
        body = await req.json()
        raw = base64.b64decode(body.get("audio_b64", ""), validate=False)
    except Exception:
        return _err("bad json / base64", 400)
    if len(raw) < 20000 or len(raw) > 6_000_000 or raw[:4] != b"RIFF":
        return _err("reference must be a WAV between ~1 s and ~60 s", 400)
    wav_path, txt_path = _ref_paths(ref_id)
    with open(wav_path, "wb") as f: f.write(raw)
    with open(txt_path, "w", encoding="utf-8") as f: f.write(" ".join(str(body.get("text", "")).split()))
    return JSONResponse({"ok": True, "ref_id": ref_id})


async def tts(req):
    if _denied(req): return _err("bad token", 401)
    try:
        b = await req.json()
        text = str(b.get("text") or "")
    except Exception:
        return _err("bad json", 400)
    if not text.strip(): return _err("empty text", 400)
    ref, ref_id = None, b.get("ref_id")
    if ref_id:
        if not REF_ID_RE.match(str(ref_id)) or not all(os.path.exists(p) for p in _ref_paths(ref_id)):
            return _err("unknown_ref", 404)                            # voicetut.js re-uploads the reference and retries
        wp, tp = _ref_paths(ref_id)
        ref = (wp, open(tp, encoding="utf-8").read().strip())
    try:
        r = await pipe.synthesize(text, speaker=b.get("speaker"), speed=b.get("speed"), num_step=b.get("num_step"),
                                  guidance=b.get("guidance_scale"), ref=ref, ref_id=ref_id, use_cache=b.get("cache", True) is not False,
                                  prepare=b.get("prepare", True) is not False)
    except EngineError as e:
        return _err(str(e), 503)
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}", 500)
    return Response(r.wav, media_type="audio/wav", headers={
        "X-Duration-Ms": str(r.duration_ms), "X-Sample-Rate": str(r.sr), "X-Trim-Lead-Ms": "0", "X-Engine": ",".join(dict.fromkeys(r.engines)),
        "X-Cache-Hits": f"{r.cache_hits}/{r.chunks}", "X-Chunks": str(r.chunks), "X-Took-Ms": str(r.took_ms), "Cache-Control": "no-store"})


async def prep_route(req):
    if _denied(req): return _err("bad token", 401)
    try: b = await req.json()
    except Exception: return _err("bad json", 400)
    from .pipeline import split_sentences
    s = prep.prepare_speech(b.get("text", ""), keep_latin=b.get("keep_latin", True) is not False)
    return JSONResponse({"spoken": s, "chunks": split_sentences(s, cfg.CHUNK_MAX, cfg.CHUNK_MIN), "egyptianized": prep.egyptianize(b.get("text", ""))})


async def metrics(req):
    if _denied(req): return _err("bad token", 401)
    return JSONResponse(pipe.metrics())


# ------------------------------------------------------------------ background activity ("always warm")
async def _warm():
    vt = _vt()
    try:
        if vt:
            await asyncio.to_thread(vt.load)
        r = await pipe.synthesize("أهلا، ازيك؟ hello", use_cache=False, timeout_s=300)   # first generation compiles kernels: pay for it now
        log.info("warm: first generation done via %s (VoiceTut %s)", ",".join(dict.fromkeys(r.engines)), "loaded" if vt and vt.loaded else "not in use")
    except Exception as e:
        log.error("warm-up failed: %s: %s", type(e).__name__, e)


_prewarm_task = None


def start_prewarm():
    """Start (or report already running) the background phrase pre-render. Returns True when a new run started."""
    global _prewarm_task
    if _prewarm_task is not None and not _prewarm_task.done():
        return False
    _prewarm_task = asyncio.create_task(_prewarm_phrases())
    return True


async def _prewarm_phrases():
    phrases = [l.strip() for l in admin.read_phrases(cfg).splitlines() if l.strip() and not l.startswith("#")]
    n = 0
    for p in phrases:
        while pipe.busy() or pipe.idle_for() < 3:                       # never compete with a live viewer
            await asyncio.sleep(1)
        try:
            await pipe.synthesize(p, timeout_s=120, touch=False)
            n += 1
        except Exception:
            pass
    pipe.event("cache", f"prewarmed {n}/{len(phrases)} phrases")
    log.info("prewarmed %d/%d phrases into the cache", n, len(phrases))


async def _keepalive():
    while True:
        await asyncio.sleep(max(15, (cfg.KEEPALIVE_S or 240) // 4))
        if cfg.KEEPALIVE_S and _primary_vt() and pipe.idle_for() >= cfg.KEEPALIVE_S and not pipe.busy():   # only VoiceTut has weights worth keeping warm
            try:
                await pipe.synthesize("تمام", use_cache=False, timeout_s=60)   # tiny real generation: weights stay paged in, CPU caches hot

            except Exception as e:
                log.warning("keepalive failed: %s: %s", type(e).__name__, e)


@contextlib.asynccontextmanager
async def lifespan(app):
    tasks = []
    async def boot():
        if cfg.WARMUP:
            await _warm()
        if cfg.PREWARM:
            start_prewarm()
    tasks.append(asyncio.create_task(boot()))
    tasks.append(asyncio.create_task(_keepalive()))                     # reads cfg.KEEPALIVE_S live (0 = idle)
    yield
    for t in tasks:
        t.cancel()


admin.load_state(cfg, pipe)
_si = admin._sysinfo(cfg)
log.info("boot: engines=%s | preferred=%s | memory limit=%s MB, used=%s MB | cpus=%s", ",".join(f"{s.engine.name}{'' if s.enabled else '(off)'}" for s in pipe.slots),
         pipe.primary.engine.name, _si.get("mem_limit_mb", "unknown"), _si.get("mem_used_mb", _si.get("rss_mb", "?")), _si.get("cpus"))
if os.environ.get("EGY_BOOT_NOTE"): pipe.event("warn", os.environ["EGY_BOOT_NOTE"])
admin.S.update(vt=_vt, prewarm=start_prewarm, ref_ok=lambda r: bool(REF_ID_RE.match(r)), ref_paths=_ref_paths)

app = Starlette(lifespan=lifespan, routes=admin.routes() + [
    Route("/health", health), Route("/ready", ready), Route("/speakers", speakers), Route("/ref/{ref_id}", put_ref, methods=["PUT"]),
    Route("/tts", tts, methods=["POST"]), Route("/prep", prep_route, methods=["POST"]), Route("/metrics", metrics),
])
