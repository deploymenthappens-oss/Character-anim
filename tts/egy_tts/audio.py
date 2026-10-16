"""Small audio helpers: read any WAV/bytes -> mono float32, trim silence, join chunks, resample, write 16-bit WAV."""
import io
import wave

import numpy as np


def read_wav(src):
    """src: path or bytes. Returns (mono float32 in [-1,1], sample_rate)."""
    buf = io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else src
    try:
        import soundfile as sf
        data, sr = sf.read(buf, dtype="float32", always_2d=False)
    except ImportError:
        from scipy.io import wavfile
        sr, data = wavfile.read(buf)
        if data.dtype.kind in "iu":
            data = data.astype("float32") / float(np.iinfo(data.dtype).max + 1)
        else:
            data = data.astype("float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return np.ascontiguousarray(data, dtype="float32"), int(sr)


def trim(data, sr, pad_ms=60):
    """Cut leading/trailing silence so the mouth does not open on dead air. Returns (data, lead_trimmed_ms)."""
    if data.size == 0:
        return data, 0
    peak = float(np.max(np.abs(data))) or 1.0
    idx = np.flatnonzero(np.abs(data) > max(0.012, peak * 0.02))
    if not idx.size:
        return data, 0
    pad = int(sr * pad_ms / 1000)
    a, b = max(0, int(idx[0]) - pad), min(data.size, int(idx[-1]) + pad)
    return data[a:b], int(round(a / sr * 1000))


def resample(data, sr_from, sr_to):
    if sr_from == sr_to or data.size == 0:
        return data
    n = int(round(data.size * sr_to / sr_from))
    return np.interp(np.linspace(0, data.size - 1, n), np.arange(data.size), data).astype("float32")


def join(chunks, sr, gap_ms=120):
    """chunks: [(array, sr)]. Resamples to `sr`, inserts silence between them."""
    gap = np.zeros(int(sr * gap_ms / 1000), dtype="float32")
    out = []
    for i, (a, s) in enumerate(chunks):
        if i:
            out.append(gap)
        out.append(resample(a, s, sr))
    return np.concatenate(out) if out else np.zeros(0, dtype="float32")


def to_pcm16(data):
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak > 0.97:
        data = data * (0.97 / peak)                       # no clipping on the 16-bit conversion
    return (np.clip(data, -1, 1) * 32767).astype("<i2")


def from_pcm16(pcm_bytes):
    return np.frombuffer(pcm_bytes, dtype="<i2").astype("float32") / 32768.0


def to_wav_bytes(data, sr):
    pcm = to_pcm16(data)
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(int(sr)); w.writeframes(pcm.tobytes())
    return b.getvalue()
