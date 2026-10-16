"""
Cairo-TTS microservice for the stream-avatar chat server  (https://github.com/MohammedAly22/Cairo-TTS, MIT code).

Egyptian Arabic + English code-switching, 20 preset voices, ZERO-SHOT CLONING from a ~10 s recording, and it runs on a
plain CPU (about 2.6x real time on a laptop i7; a GPU is optional). Same HTTP contract as ../voicetut/app.py, so the chat
server needs nothing but a different VOICETUT_URL:

  GET  /health            -> {ok, loaded, device, ...}
  GET  /speakers          -> [{name, gender, tags}]            (the preset voices)
  PUT  /ref/{id}          {audio_b64, text?}                   store the recording of YOUR voice (text is not needed)
  POST /tts               {text, speaker?, ref_id?, speed?}    -> audio/wav (16-bit mono)
                          headers: X-Duration-Ms, X-Sample-Rate, X-Trim-Lead-Ms

Env: CAIRO_TTS_MODEL (mohammedaly22/Cairo-TTS), CAIRO_TTS_DEVICE (cpu), CAIRO_TTS_QUANTIZE (1 = int8 on CPU, faster),
     VOICETUT_TOKEN (optional bearer), VOICETUT_SPEAKER (tarek), CAIRO_TEMPERATURE (0.3), CAIRO_MAX_CHARS (600),
     CAIRO_REF_DIR, CAIRO_PAD_MS (60)
     CPU thread controller: CAIRO_NUM_THREADS (0/auto = all cores the container may use minus CAIRO_RESERVE_CORES),
     CAIRO_RESERVE_CORES (1 when >=4 cores, else 0: leaves room for the chat server), CAIRO_INTEROP_THREADS (1)
     Voice-artifact filter: CAIRO_GHOST_DB (9; a faint babble before the real sentence is cut when it is that many dB quieter; 0 = off)
  GET /threads -> current budget;  POST /threads {n} -> change the torch thread count at runtime (no restart; waits for the running line)
"""
import asyncio, base64, io, os, re, tempfile, time, traceback, wave
from typing import Optional

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field

MODEL = os.environ.get("CAIRO_TTS_MODEL", "mohammedaly22/Cairo-TTS")
DEVICE = os.environ.get("CAIRO_TTS_DEVICE", "cpu")
QUANT = os.environ.get("CAIRO_TTS_QUANTIZE", "0") == "1"
TOKEN = os.environ.get("VOICETUT_TOKEN", "")
DEFAULT_SPEAKER = os.environ.get("VOICETUT_SPEAKER", "tarek")
TEMP = os.environ.get("CAIRO_TEMPERATURE")
MAX_CHARS = int(os.environ.get("CAIRO_MAX_CHARS", "600"))
PAD_MS = int(os.environ.get("CAIRO_PAD_MS", "60"))
REF_DIR = os.environ.get("CAIRO_REF_DIR", os.path.join(tempfile.gettempdir(), "cairo_refs"))
os.makedirs(REF_DIR, exist_ok=True)
REF_ID_RE = re.compile(r"^[a-f0-9]{8,64}$")



def _cpu_budget() -> int:
    """Cores this process may really use: CPU affinity AND the container's cgroup quota (docker --cpus, Railway/Kubernetes limits).
    os.cpu_count() alone reports the HOST's cores, which makes torch spawn far more threads than the quota and thrash."""
    try:
        n = len(os.sched_getaffinity(0))
    except Exception:
        n = os.cpu_count() or 1
    try:                                                       # cgroup v2
        q, per = open("/sys/fs/cgroup/cpu.max").read().split()[:2]
        if q != "max":
            n = min(n, max(1, int(int(q) / int(per) + 0.5)))
    except Exception:
        try:                                                   # cgroup v1
            q = int(open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read())
            per = int(open("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read())
            if q > 0:
                n = min(n, max(1, int(q / per + 0.5)))
        except Exception:
            pass
    return max(1, n)


def _thread_plan() -> int:
    cores = _cpu_budget()
    want = int(os.environ.get("CAIRO_NUM_THREADS", "0") or 0)
    if want > 0:
        return min(want, 256)
    reserve = int(os.environ.get("CAIRO_RESERVE_CORES", "1" if cores >= 4 else "0"))
    # a small model stops scaling after a few threads, and on shared hosts (Railway) the visible core count is the HOST's, not the
    # plan's: 30 threads on a 2-vCPU quota thrash and make every line time out. Cap the automatic choice (CAIRO_MAX_THREADS).
    return max(1, min(cores - reserve, int(os.environ.get("CAIRO_MAX_THREADS", "4"))))


THREADS = _thread_plan()
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[_v] = str(THREADS)                              # must be set before torch/numpy's BLAS start: this is why it lives at import time
GHOST_DB = float(os.environ.get("CAIRO_GHOST_DB", "9"))

app = FastAPI(title="Cairo-TTS service")
_tts = None
_load_error: Optional[str] = None
_lock = asyncio.Lock()          # one generation at a time (the model object is shared)


def _load():
    global _tts, _load_error
    if _tts is not None:
        return _tts
    try:
        from cairo_tts import CairoTTS
        t0 = time.time()
        import torch
        try:
            torch.set_num_interop_threads(max(1, int(os.environ.get("CAIRO_INTEROP_THREADS", "1"))))
        except Exception:
            pass                                               # can only be set once, before any parallel work
        _tts = CairoTTS.from_pretrained(MODEL, device=DEVICE, quantize=QUANT, num_threads=THREADS)
        print(f"[cairo] model loaded in {time.time() - t0:.1f}s on {_tts.device} (int8={_tts.quantized}, "
              f"torch threads={torch.get_num_threads()}, usable cores={_cpu_budget()})", flush=True)
        _load_error = None
        return _tts
    except Exception as e:
        _load_error = f"{type(e).__name__}: {e}"
        raise


def _ref_path(ref_id):
    return os.path.join(REF_DIR, ref_id + ".wav")


def _resolve_preset(name: Optional[str]):
    """'Mohamed' / 'mohamed' / None -> a preset id the model knows (falls back to the default speaker)."""
    ids = {v["id"].lower(): v["id"] for v in _load().voices()}
    for cand in ((name or "").strip().lower(), DEFAULT_SPEAKER.lower()):
        if cand in ids:
            return ids[cand]
    return None            # model default


def _drop_ghost_lead(data: np.ndarray, sr: int, db: float = None):
    """Cut a faint, muffled babble that the model sometimes emits BEFORE the real sentence (seen as ~1.4 s at -16 dB, a ~0.4 s gap,
    then the sentence). It is above the silence threshold, so plain trimming kept it and the mouth moved on garbage.
    Rule: split at silent gaps >= 250 ms; if the first block is < 3 s and its loud-frame level is `db` dB below the rest, drop it.
    Returns (data, dropped_ms)."""
    db = GHOST_DB if db is None else db
    if db <= 0 or data.size < sr:
        return data, 0
    hop = int(sr * 0.02)
    n = data.size // hop
    env = np.sqrt((data[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
    top = float(env.max())
    if top < 1e-4:
        return data, 0
    quiet = env < top * 0.004                                  # about -48 dB under the loudest frame
    min_gap = int(0.25 / 0.02)
    gap_end = None
    i = 0
    while i < n:                                               # first quiet run >= 250 ms that follows some sound
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            if j - i >= min_gap and i > 0 and not quiet[:i].all():
                gap_end = j
                gap_start = i
                break
            i = j
        else:
            i += 1
    if gap_end is None or gap_end >= n or gap_start * 0.02 > 3.0:
        return data, 0
    lead, rest = env[:gap_start], env[gap_end:]
    if rest.size < int(1.0 / 0.02):                            # the rest must be a real sentence (>= 1 s)
        return data, 0
    lead_lvl, rest_lvl = float(np.percentile(lead[lead > top * 0.004], 90)), float(np.percentile(rest[rest > top * 0.004], 90))
    if rest_lvl <= 0 or 20 * np.log10(rest_lvl / max(lead_lvl, 1e-9)) < db:
        return data, 0
    return data[gap_end * hop:], int(gap_end * 20)


def _to_wav16(audio: np.ndarray, sr: int):
    """Trim leading/trailing silence (the mouth must not open on dead air) and return (wav_bytes, sr, duration_ms, lead_ms)."""
    data = audio.astype("float32").reshape(-1)
    lead = 0
    data, ghost_ms = _drop_ghost_lead(data, sr)
    if ghost_ms:
        print(f"[cairo] dropped a {ghost_ms} ms faint lead-in (model babble before the sentence)", flush=True)
    if data.size:
        peak = float(np.max(np.abs(data))) or 1.0
        idx = np.flatnonzero(np.abs(data) > max(0.012, peak * 0.02))
        if idx.size:
            pad = int(sr * PAD_MS / 1000)
            a, b = max(0, int(idx[0]) - pad), min(data.size, int(idx[-1]) + pad)
            lead, data = a, data[a:b]
        data = data * min(1.0, 0.97 / (float(np.max(np.abs(data))) or 1.0))
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(int(sr)); w.writeframes(pcm.tobytes())
    return buf.getvalue(), int(sr), int(round(len(pcm) / sr * 1000)), int(round((lead + int(ghost_ms * sr / 1000)) / sr * 1000))


def _clean_ref(raw: bytes) -> bytes:
    """A cloning reference must start with the voice, not with silence/babble: the model imitates the prompt, including a faint
    lead-in (the shipped my-voice.wav had 1.4 s of it + a gap, and every cloned line inherited the defect). Clean it on upload."""
    import soundfile as sf
    x, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    y, ghost = _drop_ghost_lead(x, sr)
    idx = np.flatnonzero(np.abs(y) > max(0.01, float(np.max(np.abs(y)) if y.size else 0) * 0.03))
    if idx.size:
        pad = int(sr * 0.08)
        y = y[max(0, int(idx[0]) - pad): min(y.size, int(idx[-1]) + pad)]
    if y.size < sr * 1.0:                                       # never turn a usable reference into nothing
        return raw
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="PCM_16")
    print(f"[cairo] reference cleaned: {x.size/sr:.1f}s -> {y.size/sr:.1f}s (lead-in dropped: {ghost} ms)", flush=True)
    return buf.getvalue()


def _generate(text, voice, speed):
    tts = _load()
    kw = {}
    if TEMP:
        kw["temperature"] = float(TEMP)
    audio = tts.generate(text, voice, **kw)
    if speed and abs(speed - 1.0) > 0.03:                      # light speed change by resampling the result (pitch shifts slightly)
        from scipy.signal import resample
        audio = resample(audio, int(len(audio) / speed)).astype("float32")
    return _to_wav16(audio, tts.sample_rate)


class TTSReq(BaseModel):
    text: str = Field(..., min_length=1)
    speaker: Optional[str] = None
    ref_id: Optional[str] = None       # a recording stored with PUT /ref/{id}: speak in that (cloned) voice
    speed: Optional[float] = None


class RefReq(BaseModel):
    audio_b64: str = Field(..., min_length=100)
    text: Optional[str] = None         # accepted for compatibility; Cairo-TTS does not need a transcript


def _auth(authorization: Optional[str]):
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "bad token")


@app.on_event("startup")
async def _startup():
    async def warm():
        try:
            await asyncio.to_thread(_load)
            await asyncio.to_thread(lambda: _load().warmup())
            print("[cairo] warm", flush=True)
        except Exception as e:
            print(f"[cairo] warm-up failed: {e}", flush=True)
    asyncio.create_task(warm())


@app.get("/health")
async def health():
    return {"ok": _tts is not None, "loaded": _tts is not None, "error": _load_error, "repo": MODEL,
            "device": getattr(_tts, "device", DEVICE), "int8": getattr(_tts, "quantized", QUANT), "speaker": DEFAULT_SPEAKER,
            "threads": _threads_now(), "usable_cores": _cpu_budget()}


def _threads_now():
    try:
        import torch
        return torch.get_num_threads()
    except Exception:
        return THREADS


class ThreadsReq(BaseModel):
    n: int = Field(..., ge=1, le=256)


@app.get("/threads")
async def threads_get(authorization: Optional[str] = Header(None)):
    _auth(authorization)
    return {"torch_threads": _threads_now(), "planned": THREADS, "usable_cores": _cpu_budget()}


@app.post("/threads")
async def threads_set(req: ThreadsReq, authorization: Optional[str] = Header(None)):
    """Thread controller: change how many CPU threads synthesis uses, live. Waits for the line being generated, then applies."""
    _auth(authorization)
    import torch
    async with _lock:
        await asyncio.to_thread(torch.set_num_threads, req.n)
    print(f"[cairo] torch threads -> {req.n}", flush=True)
    return {"ok": True, "torch_threads": torch.get_num_threads()}


@app.get("/selftest")
async def selftest(ref_id: Optional[str] = None, authorization: Optional[str] = Header(None)):
    """One short real generation (preset, or the stored reference with ?ref_id=): returns timing or the exact error."""
    _auth(authorization)
    t0 = time.time()
    try:
        async with _lock:
            voice = _ref_path(ref_id) if ref_id and REF_ID_RE.match(ref_id) and os.path.exists(_ref_path(ref_id)) else await asyncio.to_thread(_resolve_preset, None)
            wav, sr, dur, lead = await asyncio.to_thread(_generate, "اهلا بيكم في اللايف", voice, None)
        took = time.time() - t0
        return {"ok": True, "audio_ms": dur, "took_s": round(took, 2), "rtf": round(took / max(dur / 1000, 0.001), 2), "threads": _threads_now()}
    except Exception as e:
        traceback.print_exc()
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "took_s": round(time.time() - t0, 2)}


@app.get("/speakers")
async def speakers(authorization: Optional[str] = Header(None)):
    _auth(authorization)
    vs = await asyncio.to_thread(lambda: _load().voices())
    return [{"name": v["id"], "gender": v.get("gender"), "tags": [v.get("name_en") or "", v.get("description_en") or ""]} for v in vs]


@app.put("/ref/{ref_id}")
async def put_ref(ref_id: str, req: RefReq, authorization: Optional[str] = Header(None)):
    _auth(authorization)
    if not REF_ID_RE.match(ref_id):
        raise HTTPException(400, "bad ref id")
    try:
        raw = base64.b64decode(req.audio_b64)
    except Exception:
        raise HTTPException(400, "audio_b64 is not valid base64")
    if len(raw) < 20000 or len(raw) > 8_000_000:
        raise HTTPException(400, "reference must be a WAV between ~1 s and ~60 s")
    try:
        raw = await asyncio.to_thread(_clean_ref, raw)
    except Exception as e:
        raise HTTPException(400, f"unusable recording: {e}")
    path = _ref_path(ref_id)
    with open(path, "wb") as f:
        f.write(raw)
    try:                                                       # compute the voice prompt now: bad audio fails here, not on a viewer's comment
        async with _lock:
            await asyncio.to_thread(lambda: _load().voice_state(path))
    except Exception as e:
        try: os.remove(path)
        except OSError: pass
        raise HTTPException(400, f"unusable recording: {e}")
    print(f"[cairo] reference {ref_id} stored ({len(raw)//1024} KB)", flush=True)
    return {"ok": True, "ref_id": ref_id}


@app.post("/tts")
async def tts_endpoint(req: TTSReq, authorization: Optional[str] = Header(None)):
    _auth(authorization)
    text = " ".join(req.text.split())[:MAX_CHARS]
    if not text:
        raise HTTPException(400, "empty text")
    if req.ref_id:
        if not REF_ID_RE.match(req.ref_id) or not os.path.exists(_ref_path(req.ref_id)):
            return JSONResponse({"error": "unknown_ref"}, status_code=404)       # the chat server re-uploads the recording and retries
    t0 = time.time()
    try:
        async with _lock:
            voice = _ref_path(req.ref_id) if req.ref_id else await asyncio.to_thread(_resolve_preset, req.speaker)
            wav, sr, dur, lead = await asyncio.to_thread(_generate, text, voice, req.speed)
    except ValueError as e:                                    # e.g. nothing speakable after normalization
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        traceback.print_exc()                                  # the root cause must be in the host's log, not only in the HTTP body
        return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=500)
    took = time.time() - t0
    print(f"[cairo] {len(text)} chars, {dur/1000:.1f}s audio in {took:.1f}s (RTF {took/max(0.001,dur/1000):.2f}) voice={'MY-VOICE' if req.ref_id else req.speaker}", flush=True)
    return Response(wav, media_type="audio/wav", headers={
        "X-Duration-Ms": str(dur), "X-Sample-Rate": str(sr), "X-Trim-Lead-Ms": str(lead), "Cache-Control": "no-store"})
