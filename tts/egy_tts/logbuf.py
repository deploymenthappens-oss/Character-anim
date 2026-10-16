"""Logging for the TTS service: one `egy_tts` logger that (a) still prints to stdout like the old print() calls did and
(b) keeps the last LOG_BUFFER_LINES lines in memory so the dashboard's Logs tab can show them (GET /admin/api/logs).

Secrets never enter the buffer: Bearer tokens, common API-key shapes and the value of any environment variable whose name
contains TOKEN / KEY / SECRET / PASSWORD / PASS are replaced with ***.
"""
import logging
import os
import re
import sys
import threading
import time
from collections import deque

LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
_NAME = {logging.DEBUG: "debug", logging.INFO: "info", logging.WARNING: "warn", logging.ERROR: "error", logging.CRITICAL: "error"}
MAX = max(100, int(os.environ.get("LOG_BUFFER_LINES", "1000") or 1000))
MAX_LINE = 2000
BOOT = format(int(time.time() * 1000), "x")          # changes on every restart so a polling client knows its cursor is stale

_SECRET_NAME = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|PASS\b", re.I)
_BEARER = re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}", re.I)
_KEYSHAPE = re.compile(r"\b(sk|gsk|hf|ghp|xox[bp])[-_][A-Za-z0-9_-]{12,}")
_ASSIGN = re.compile(r"""((?:token|password|passwd|api[_-]?key|secret)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}""", re.I)


def redact(s: str) -> str:
    s = _BEARER.sub(r"\1 ***", s)
    s = _KEYSHAPE.sub("***", s)
    s = _ASSIGN.sub(r"\1***", s)
    for k, v in os.environ.items():                  # exact values of configured secrets, wherever they show up
        if v and len(v) >= 8 and _SECRET_NAME.search(k) and v in s:
            s = s.replace(v, "***")
    return s


class RingHandler(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.buf = deque(maxlen=MAX)
        self.next_id = 1

    def emit(self, record):
        try:
            msg = redact(record.getMessage())
            if record.exc_info:
                msg += " | " + redact(f"{record.exc_info[0].__name__}: {record.exc_info[1]}")
            if len(msg) > MAX_LINE:
                msg = msg[:MAX_LINE] + " …[truncated]"
            with self.lock:
                self.buf.append({"id": self.next_id, "t": int(record.created * 1000), "level": _NAME.get(record.levelno, "info"),
                                 "src": "tts", "msg": msg})
                self.next_id += 1
        except Exception:                            # logging must never break a request
            pass

    def read(self, since=0, level="debug", limit=300):
        mn, limit = LEVELS.get(level, 0), max(1, min(MAX, int(limit)))
        with self.lock:
            items = [e for e in self.buf if e["id"] > since and LEVELS[e["level"]] >= mn]
            nxt = self.next_id - 1
        return {"service": "tts", "boot": BOOT, "next": nxt, "items": items[-limit:]}


_ring = RingHandler()
log = logging.getLogger("egy_tts")


def _setup():
    if getattr(log, "_egy_ready", False):
        return
    log.setLevel(getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO))
    out = logging.StreamHandler(sys.stdout)
    out.setFormatter(logging.Formatter("[tts] %(levelname)s %(message)s"))
    log.addHandler(out)
    log.addHandler(_ring)
    log.propagate = False                            # uvicorn configures the root logger; don't print everything twice
    log._egy_ready = True


_setup()


def read(since=0, level="debug", limit=300):
    return _ring.read(since, level, limit)
