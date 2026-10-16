"""text -> prep -> sentence chunks -> (cache | engine chain with timeouts/backpressure/circuit breaker) -> joined 16-bit WAV."""
import asyncio
import logging
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from . import audio, prep
from .cache import AudioCache, make_key
from .config import Config
from .engines import ENGINE_CLASSES, EngineError
from .logbuf import log

DEFAULT_ENGINES = ("voicetut", "edge", "espeak")
_END = re.compile(r"(?<=[.!?؟…؛;])\s+|\n+")


def split_sentences(text: str, max_len: int = 160, min_len: int = 24):
    """Sentence chunks sized for TTS: short enough to start fast and cache well, long enough to keep intonation."""
    pieces = [p.strip() for p in _END.split(text) if p and p.strip()]
    merged = []
    for p in pieces:                                                  # glue fragments ("Hi!") onto their neighbour
        if merged and (len(merged[-1]) < min_len or len(p) < min_len) and len(merged[-1]) + len(p) + 1 <= max_len:
            merged[-1] += " " + p
        else:
            merged.append(p)
    out = []
    for p in merged:
        while len(p) > max_len:                                       # hard split: prefer a comma, then a space
            cut = max(p.rfind("،", 0, max_len), p.rfind(",", 0, max_len))
            if cut < min_len:
                cut = p.rfind(" ", 0, max_len)
            if cut < min_len:
                cut = max_len
            out.append(p[:cut + 1].strip()); p = p[cut + 1:].strip()
        if p:
            out.append(p)
    return out


@dataclass
class Result:
    wav: bytes
    sr: int
    duration_ms: int
    engines: list
    cache_hits: int
    chunks: int
    took_ms: int
    spoken: str = ""


class Slot:
    """Runtime state of one engine: its worker pool, queue depth, circuit breaker and counters."""

    def __init__(self, engine, workers):
        self.engine = engine
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=engine.name)
        self.pending = 0
        self.enabled = True
        self.down_until = 0.0
        self.last_error = ""
        self.stats = dict(ok=0, fail=0, timeout=0, skipped_busy=0, audio_s=0.0, work_s=0.0)
        self._lock = threading.Lock()

    def usable(self, max_queue):
        if not self.engine.available() or time.time() < self.down_until:
            return False
        return self.pending < max_queue

    def add_pending(self, d):
        with self._lock:
            self.pending += d


class Pipeline:
    def __init__(self, cfg: Config = None):
        self.cfg = cfg or Config()
        self.cache = AudioCache(self.cfg)
        self.slots = []
        listed = [n for n in self.cfg.ENGINES if n in ENGINE_CLASSES]
        if not listed:
            raise ValueError("ENGINES lists no known engine: " + ",".join(self.cfg.ENGINES))
        for name in listed + [n for n in DEFAULT_ENGINES if n not in listed]:    # unlisted real engines exist but start disabled (admin can enable them)
            slot = Slot(ENGINE_CLASSES[name](self.cfg), 1 if name == "voicetut" else 2)
            slot.enabled = name in listed
            self.slots.append(slot)
        self.log = deque(maxlen=300)                                  # recent requests (the admin dashboard reads this)
        self.events = deque(maxlen=300)                               # engine failures, reloads, setting changes
        self.started = time.time()
        self.last_request = time.time()
        self.totals = dict(requests=0, errors=0, chars=0, audio_s=0.0, took_s=0.0)

    def chain(self): return [s for s in self.slots if s.enabled]

    @property
    def primary(self):
        c = self.chain()
        return c[0] if c else self.slots[0]

    def slot(self, name):
        return next((s for s in self.slots if s.engine.name == name), None)

    def set_order(self, names):
        """Reorder engines; names not listed keep their relative order after the listed ones."""
        by = {s.engine.name: s for s in self.slots}
        head = [by[n] for n in names if n in by]
        self.slots = head + [s for s in self.slots if s not in head]

    def event(self, kind, msg):
        self.events.appendleft({"t": int(time.time()), "kind": kind, "msg": msg})
        log.log(logging.WARNING if kind in ("error", "timeout", "warn") else logging.INFO, "[%s] %s", kind, msg)

    # ------------------------------------------------------------ one chunk through the chain
    async def _chunk(self, text, speaker, speed, num_step, guidance, ref, ref_id, use_cache, deadline):
        chain = self.chain()
        if not chain:
            raise EngineError("all engines are disabled")
        for i, slot in enumerate(chain):
            eng, last = slot.engine, i == len(chain) - 1
            t = text if eng.keep_latin else prep.arabize_latin(text)
            if not t.strip():
                continue
            key = make_key(eng.signature(speaker, speed, num_step, guidance, ref_id), t)
            if use_cache:
                hit = await self.cache.aget(key)
                if hit:
                    return audio.from_pcm16(hit[0]), hit[1], eng.name, True
            if ref and not eng.supports_ref and not last:
                continue                                              # a cloned voice cannot be faked by another engine: try the next one
            if last:                                                  # the last resort ignores queue limit and breaker: it is all we have
                if not eng.available():
                    continue
            elif not slot.usable(self.cfg.MAX_QUEUE):
                if eng.available() and time.time() >= slot.down_until:
                    slot.stats["skipped_busy"] += 1
                continue
            budget = deadline - time.time()
            if last:
                budget = max(budget, 6.0)                             # the last resort always gets a fair chance
            elif budget < self.cfg.MIN_BUDGET_S:
                continue
            job = self._make_job(slot, t, key, speaker, speed, num_step, guidance, ref, use_cache)
            slot.add_pending(1)
            fut = slot.pool.submit(job)
            fut.add_done_callback(lambda f, s=slot: s.add_pending(-1))
            try:
                pcm, sr = await asyncio.wait_for(asyncio.wrap_future(fut), timeout=budget)
                return audio.from_pcm16(pcm), sr, eng.name, False
            except asyncio.TimeoutError:                              # the job keeps running and will still land in the cache
                slot.stats["timeout"] += 1
                slot.last_error = f"timeout after {budget:.1f}s"
                self.event("timeout", f"{eng.name}: {slot.last_error}")
                slot.down_until = time.time() + self.cfg.COOLDOWN_S
            except Exception as e:
                slot.stats["fail"] += 1
                slot.last_error = f"{type(e).__name__}: {e}"
                self.event("error", f"{eng.name}: {slot.last_error[:200]}")
                if not isinstance(e, EngineError) or "load" not in str(e).lower():
                    slot.down_until = time.time() + self.cfg.COOLDOWN_S
        raise EngineError("no engine could speak this chunk: " + "; ".join(f"{s.engine.name}: {s.last_error or 'unavailable'}" for s in chain))

    def _make_job(self, slot, text, key, speaker, speed, num_step, guidance, ref, use_cache):
        def job():
            t0 = time.time()
            data, sr = slot.engine.synth(text, speaker=speaker, speed=speed, num_step=num_step, guidance=guidance, ref=ref)
            data, _ = audio.trim(data, sr, self.cfg.PAD_MS)
            if data.size < sr * 0.05:
                raise EngineError("engine returned (almost) no audio")
            pcm = audio.to_pcm16(data).tobytes()
            dt = time.time() - t0
            slot.stats["ok"] += 1; slot.stats["work_s"] += dt; slot.stats["audio_s"] += data.size / sr
            slot.down_until = 0.0                                     # a success closes the breaker
            if use_cache:
                self.cache.put(key, pcm, sr)
            return pcm, sr
        return job

    # ------------------------------------------------------------ public
    async def synthesize(self, text, speaker=None, speed=None, num_step=None, guidance=None, ref=None, ref_id=None,
                         use_cache=True, prepare=True, timeout_s=None, touch=True) -> Result:
        t0 = time.time()
        if touch:
            self.last_request = t0
        text = " ".join(str(text or "").split())[: self.cfg.MAX_CHARS]
        if not text:
            raise ValueError("empty text")
        spoken = prep.prepare_speech(text, keep_latin=True) if prepare else text
        chunks = split_sentences(spoken, self.cfg.CHUNK_MAX, self.cfg.CHUNK_MIN)
        deadline = t0 + (timeout_s or self.cfg.TIMEOUT_S)
        speaker, speed = speaker or self.cfg.SPEAKER, speed or self.cfg.SPEED
        parts, engines, hits = [], [], 0
        self.totals["requests"] += 1
        entry = {"t": int(t0), "chars": len(text), "text": text[:60] if self.cfg.LOG_TEXT else "", "speaker": speaker, "chunks": len(chunks)}
        try:
            for c in chunks:
                data, sr, eng, cached = await self._chunk(c, speaker, speed, num_step, guidance, ref, ref_id, use_cache, deadline)
                parts.append((data, sr)); engines.append(eng); hits += int(cached)
        except Exception as e:
            self.totals["errors"] += 1
            self.log.appendleft({**entry, "ok": False, "error": f"{type(e).__name__}: {e}"[:200], "took_ms": int((time.time() - t0) * 1000)})
            log.warning("tts FAILED chars=%d chunks=%d speaker=%s took=%dms: %s: %s", len(text), len(chunks), speaker,
                        int((time.time() - t0) * 1000), type(e).__name__, str(e)[:200])
            raise
        sr0 = parts[0][1]
        wave = audio.join(parts, sr0, self.cfg.GAP_MS)
        took = time.time() - t0
        self.totals["chars"] += len(text); self.totals["audio_s"] += wave.size / sr0; self.totals["took_s"] += took
        self.log.appendleft({**entry, "ok": True, "engines": list(dict.fromkeys(engines)), "cache": f"{hits}/{len(chunks)}",
                             "took_ms": int(took * 1000), "audio_ms": int(wave.size / sr0 * 1000)})
        log.info("tts ok chars=%d chunks=%d speaker=%s engines=%s cache=%d/%d took=%dms audio=%dms%s", len(text), len(chunks), speaker,
                 ",".join(dict.fromkeys(engines)), hits, len(chunks), int(took * 1000), int(wave.size / sr0 * 1000),
                 f" text={entry['text']!r}" if entry["text"] else "")
        return Result(audio.to_wav_bytes(wave, sr0), sr0, int(round(wave.size / sr0 * 1000)), engines, hits, len(chunks),
                      int(took * 1000), spoken)

    def idle_for(self): return time.time() - self.last_request

    def busy(self): return any(s.pending for s in self.slots)

    def metrics(self):
        t = self.totals
        return {
            "uptime_s": int(time.time() - self.started), "totals": {**t, "audio_s": round(t["audio_s"], 1), "took_s": round(t["took_s"], 1),
            "rtf": round(t["took_s"] / t["audio_s"], 2) if t["audio_s"] else None}, "cache": self.cache.stats(),
            "engines": [{**s.engine.info(), "available": s.engine.available(), "enabled": s.enabled, "pending": s.pending, "cooling": time.time() < s.down_until,
                         "last_error": s.last_error, **{k: (round(v, 1) if isinstance(v, float) else v) for k, v in s.stats.items()},
                         "rtf": round(s.stats["work_s"] / s.stats["audio_s"], 2) if s.stats["audio_s"] else None} for s in self.slots]}
