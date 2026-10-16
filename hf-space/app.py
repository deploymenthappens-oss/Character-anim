"""
VoiceTut TTS microservice for the stream-avatar chat server.

Wraps https://huggingface.co/mohammedaly22/VoiceTut-TTS (Egyptian Arabic + English code-switching, Apache-2.0)
behind a tiny HTTP API, because the model is a 0.6B PyTorch model that wants a GPU and cannot live inside the
Node/Railway container. chat/voicetut.js calls this; if it is down, the chat server falls back to Edge, then espeak-ng.

  GET  /health            -> {ok, loaded, device, speakers}
  GET  /speakers          -> [{name, gender, tags}]
  POST /tts               {text, speaker?, speed?, num_step?, guidance_scale?}  -> audio/wav (16-bit mono)
                          headers: X-Duration-Ms, X-Sample-Rate, X-Trim-Lead-Ms

Env: VOICETUT_REPO (default mohammedaly22/VoiceTut-TTS), VOICETUT_TOKEN (optional bearer), VOICETUT_SPEAKER,
     VOICETUT_NUM_STEP (32), VOICETUT_GUIDANCE (2.5), VOICETUT_SPEED (1.0), VOICETUT_MAX_CHARS (600), VOICETUT_WARMUP (1)

Only the documented API is used: VoiceTutTTS.from_pretrained, .synthesize(text, speaker=, output=, num_step=,
guidance_scale=, speed=), .synthesize_long(text, path, speaker=), .list_speakers().
"""
import asyncio, base64, io, os, re, tempfile, time, wave
from typing import Optional

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field

REPO = os.environ.get("VOICETUT_REPO", "mohammedaly22/VoiceTut-TTS")
TOKEN = os.environ.get("VOICETUT_TOKEN", "")
DEFAULT_SPEAKER = os.environ.get("VOICETUT_SPEAKER", "Mohamed")
NUM_STEP = int(os.environ.get("VOICETUT_NUM_STEP", "32"))
GUIDANCE = float(os.environ.get("VOICETUT_GUIDANCE", "2.5"))
SPEED = float(os.environ.get("VOICETUT_SPEED", "1.0"))
MAX_CHARS = int(os.environ.get("VOICETUT_MAX_CHARS", "600"))
LONG_AT = int(os.environ.get("VOICETUT_LONG_AT", "180"))      # above this many chars use synthesize_long (sentence chunks)
PAD_MS = int(os.environ.get("VOICETUT_PAD_MS", "60"))        # silence kept around the speech after trimming
REF_DIR = os.environ.get("VOICETUT_REF_DIR", os.path.join(tempfile.gettempdir(), "voicetut_refs"))   # cloned-voice references (sent by the chat server)
os.makedirs(REF_DIR, exist_ok=True)
REF_ID_RE = re.compile(r"^[a-f0-9]{8,64}$")

app = FastAPI(title="VoiceTut TTS service")
_tts = None
_load_error: Optional[str] = None
_lock = asyncio.Lock()                                        # one generation at a time: the model is not re-entrant
_speakers_cache = None


def _load():
    global _tts, _load_error
    if _tts is not None:
        return _tts
    try:
        from voicetut_tts import VoiceTutTTS
        t0 = time.time()
        _tts = VoiceTutTTS.from_pretrained(REPO)
        print(f"[voicetut] model loaded in {time.time() - t0:.1f}s", flush=True)
        _load_error = None
        return _tts
    except Exception as e:                                     # surfaced by /health so the Node side can tell why
        _load_error = f"{type(e).__name__}: {e}"
        raise


def _device():
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "unknown"


def _speakers():
    global _speakers_cache
    if _speakers_cache is not None:
        return _speakers_cache
    out = []
    try:
        for s in _load().list_speakers():
            g = lambda k, d=None: (s.get(k, d) if isinstance(s, dict) else getattr(s, k, d))
            out.append({"name": g("name") or str(s), "gender": g("gender"), "tags": g("tags") or []})
    except Exception as e:
        print(f"[voicetut] list_speakers failed ({e}); using the model-card names", flush=True)
        out = [{"name": n, "gender": "female" if n in FEMALE else "male", "tags": []} for n in CARD_SPEAKERS]
    _speakers_cache = out
    return out


CARD_SPEAKERS = ["Mohamed", "Abdelrahman", "Abdullah", "Kamal", "Hossam", "Omar", "Sayed", "Zaki", "Aly", "Essam", "Ahmed",
                 "Asmaa", "Esraa", "Hanan", "Sarah", "Yasmin", "Omnia"]
FEMALE = {"Asmaa", "Esraa", "Hanan", "Sarah", "Yasmin", "Omnia"}


def _trim_to_wav16(path: str):
    """Read what the model wrote, trim leading/trailing silence (keeps the mouth from opening on dead air and keeps
    the audio clock aligned with the text for lip-sync), return (wav_bytes, sr, duration_ms, lead_trim_ms)."""
    import soundfile as sf
    data, sr = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    lead = 0
    if data.size:
        peak = float(np.max(np.abs(data))) or 1.0
        thr = max(0.012, peak * 0.02)
        idx = np.flatnonzero(np.abs(data) > thr)
        if idx.size:
            pad = int(sr * PAD_MS / 1000)
            a, b = max(0, int(idx[0]) - pad), min(data.size, int(idx[-1]) + pad)
            lead = a
            data = data[a:b]
        data = data * min(1.0, 0.97 / (float(np.max(np.abs(data))) or 1.0))      # no clipping on the 16-bit conversion
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(int(sr)); w.writeframes(pcm.tobytes())
    return buf.getvalue(), int(sr), int(round(len(pcm) / sr * 1000)), int(round(lead / sr * 1000))


def _ref_paths(ref_id):
    return os.path.join(REF_DIR, ref_id + ".wav"), os.path.join(REF_DIR, ref_id + ".txt")


def _generate(text, speaker, speed, num_step, guidance, ref_id=None):
    tts = _load()
    if ref_id:                                                 # cloned voice: zero-shot from the reference recording + its transcript
        wav_path, txt_path = _ref_paths(ref_id)
        voice = {"ref_audio": wav_path, "ref_text": open(txt_path, encoding="utf-8").read().strip()}
    else:
        voice = {"speaker": speaker}
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "out.wav")
        if len(text) > LONG_AT and hasattr(tts, "synthesize_long"):
            tts.synthesize_long(text, out, **voice)
        else:
            tts.synthesize(text, num_step=num_step, guidance_scale=guidance, speed=speed, output=out, **voice)
        return _trim_to_wav16(out)


class TTSReq(BaseModel):
    text: str = Field(..., min_length=1)
    speaker: Optional[str] = None
    speed: Optional[float] = None
    num_step: Optional[int] = None
    guidance_scale: Optional[float] = None
    ref_id: Optional[str] = None          # id of a reference stored with PUT /ref/{id}: speak in that (cloned) voice


class RefReq(BaseModel):
    audio_b64: str = Field(..., min_length=100)   # WAV of the person's own voice, 3-15 s
    text: str = ""                                # exactly what is said in that recording (VoiceTut wants it; Cairo does not)


def _auth(authorization: Optional[str]):
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "bad token")


@app.on_event("startup")
async def _startup():
    if os.environ.get("VOICETUT_WARMUP", "1") == "0":
        return
    async def warm():
        try:
            await asyncio.to_thread(_load)
            async with _lock:                                  # first generation compiles kernels: pay for it now, not on a viewer's comment
                await asyncio.to_thread(_generate, "أهلا، ازيك؟ hello", DEFAULT_SPEAKER, SPEED, 8, GUIDANCE)
            print("[voicetut] warm", flush=True)
        except Exception as e:
            print(f"[voicetut] warm-up failed: {e}", flush=True)
    asyncio.create_task(warm())


@app.get("/health")
async def health():
    return {"ok": _tts is not None, "loaded": _tts is not None, "error": _load_error, "device": _device(), "repo": REPO,
            "speaker": DEFAULT_SPEAKER}


@app.get("/speakers")
async def speakers(authorization: Optional[str] = Header(None)):
    _auth(authorization)
    return await asyncio.to_thread(_speakers)


@app.put("/ref/{ref_id}")
async def put_ref(ref_id: str, req: RefReq, authorization: Optional[str] = Header(None)):
    _auth(authorization)
    if not REF_ID_RE.match(ref_id):
        raise HTTPException(400, "bad ref id")
    try:
        raw = base64.b64decode(req.audio_b64, validate=False)
    except Exception:
        raise HTTPException(400, "audio_b64 is not valid base64")
    if len(raw) < 20000 or len(raw) > 6_000_000 or raw[:4] != b"RIFF":
        raise HTTPException(400, "reference must be a WAV between ~1 s and ~60 s")
    wav_path, txt_path = _ref_paths(ref_id)
    with open(wav_path, "wb") as f: f.write(raw)
    with open(txt_path, "w", encoding="utf-8") as f: f.write(" ".join(req.text.split()) or ".")
    print(f"[voicetut] reference {ref_id} stored ({len(raw)//1024} KB)", flush=True)
    return {"ok": True, "ref_id": ref_id}


@app.post("/tts")
async def tts_endpoint(req: TTSReq, authorization: Optional[str] = Header(None)):
    _auth(authorization)
    text = " ".join(req.text.split())[:MAX_CHARS]
    if not text:
        raise HTTPException(400, "empty text")
    speaker = req.speaker or DEFAULT_SPEAKER
    if req.ref_id:
        if not REF_ID_RE.match(req.ref_id) or not all(os.path.exists(p) for p in _ref_paths(req.ref_id)):
            return JSONResponse({"error": "unknown_ref"}, status_code=404)      # the chat server re-uploads the reference and retries
    t0 = time.time()
    try:
        async with _lock:
            wav, sr, dur, lead = await asyncio.to_thread(
                _generate, text, speaker, req.speed or SPEED, req.num_step or NUM_STEP, req.guidance_scale or GUIDANCE, req.ref_id)
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=500)
    took = time.time() - t0
    print(f"[voicetut] {len(text)} chars, {dur/1000:.1f}s audio in {took:.1f}s (RTF {took/max(0.001,dur/1000):.2f}) speaker={speaker}", flush=True)
    return Response(wav, media_type="audio/wav", headers={
        "X-Duration-Ms": str(dur), "X-Sample-Rate": str(sr), "X-Trim-Lead-Ms": str(lead), "Cache-Control": "no-store"})
