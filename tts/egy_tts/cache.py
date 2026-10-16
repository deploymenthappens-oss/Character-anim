"""Audio cache: memory LRU in front of ONE optional persistent store (a database or a directory). Stores 16-bit PCM + sample rate per
sentence chunk. Repeated phrases (greetings, acknowledgements, viewer names) cost nothing after the first time - the biggest CPU saver.

Persistent store, chosen from environment variables (see Config; nothing to change in code):
  CACHE_DATABASE_URL (or DATABASE_URL)   postgres://... / postgresql://...  (Railway Postgres)   or   sqlite:///path/to/file.db
  otherwise                              files in CACHE_DIR (needs a mounted volume to survive a redeploy)
  CACHE_DISK_MB=0 and no URL             memory only (cold after every restart, but the service never needs a disk or a database)
The database is a pure cache: if it is slow, down or misconfigured the service keeps answering (a miss is just a generation), it logs the
error in /admin/api/status, backs off for 30 s, and tries again."""
import asyncio
import hashlib
import os
import re
import struct
import threading
import time
from collections import OrderedDict

TABLE = "egy_tts_cache"


def make_key(*parts) -> str:
    return hashlib.sha1("\x1f".join(str(p) for p in parts).encode("utf-8")).hexdigest()


# ------------------------------------------------------------------------------------------------ persistent stores
class DiskStore:
    kind = "disk"

    def __init__(self, directory, cap_bytes):
        self.dir, self.cap = directory, cap_bytes
        os.makedirs(directory, exist_ok=True)

    def _path(self, key): return os.path.join(self.dir, key + ".pcm")

    def get(self, key):
        try:
            with open(self._path(key), "rb") as f:
                raw = f.read()
            return raw[4:], struct.unpack("<I", raw[:4])[0]
        except OSError:
            return None

    def put(self, key, pcm, sr):
        tmp = self._path(key) + ".tmp"
        with open(tmp, "wb") as f:
            f.write(struct.pack("<I", sr) + pcm)
        os.replace(tmp, self._path(key))
        self._trim()

    def _trim(self):
        try:
            files = [(e.stat().st_mtime, e.stat().st_size, e.path) for e in os.scandir(self.dir) if e.name.endswith(".pcm")]
            total = sum(s for _, s, _ in files)
            for _, s, p in sorted(files):                  # oldest first
                if total <= self.cap: break
                os.unlink(p); total -= s
        except OSError:
            pass

    def clear(self):
        n = 0
        for e in os.scandir(self.dir):
            if e.name.endswith(".pcm"): os.unlink(e.path); n += 1
        return n

    def usage(self):
        files = [e.stat().st_size for e in os.scandir(self.dir) if e.name.endswith(".pcm")]
        return len(files), sum(files)


class SqlStore:
    """One table, one connection (guarded by a lock). sqlite for local/tests, postgres for Railway. Same SQL for both."""
    def __init__(self, url, cap_bytes):
        self.url, self.cap, self.lock, self.conn, self.puts = url.strip(), cap_bytes, threading.Lock(), None, 0
        u = self.url.lower()
        self.kind = "sqlite" if u.startswith("sqlite") else "postgres"
        if self.kind == "postgres" and not (u.startswith("postgres://") or u.startswith("postgresql://")):
            raise ValueError("CACHE_DATABASE_URL must start with postgres://, postgresql:// or sqlite:///")
        self.ph = "?" if self.kind == "sqlite" else "%s"
        self._connect()

    def _connect(self):
        if self.kind == "sqlite":
            import sqlite3
            path = re.sub(r"^sqlite:(//)?", "", self.url, flags=re.I) or ":memory:"
            if path.startswith("/") and path[1:3] == "//": path = path[1:]          # sqlite:////abs/path
            if path != ":memory:" and os.path.dirname(path): os.makedirs(os.path.dirname(path), exist_ok=True)
            self.conn = sqlite3.connect(path, check_same_thread=False, timeout=5, isolation_level=None)
            blob = "BLOB"
        else:
            import psycopg                                                          # in requirements.txt; imported only when a postgres URL is used
            self.conn = psycopg.connect(self.url, connect_timeout=5, autocommit=True)
            blob = "BYTEA"
        self.conn.execute(f"CREATE TABLE IF NOT EXISTS {TABLE} (key TEXT PRIMARY KEY, sr INTEGER NOT NULL, pcm {blob} NOT NULL, "
                          f"size INTEGER NOT NULL, created_at DOUBLE PRECISION NOT NULL)" if self.kind == "postgres" else
                          f"CREATE TABLE IF NOT EXISTS {TABLE} (key TEXT PRIMARY KEY, sr INTEGER NOT NULL, pcm {blob} NOT NULL, "
                          f"size INTEGER NOT NULL, created_at REAL NOT NULL)")

    def _q(self, sql, args=()):
        """Run one statement; on a broken connection reconnect once. Returns rows (list) for SELECT, else rowcount."""
        for attempt in (0, 1):
            try:
                cur = self.conn.execute(sql.replace("?", self.ph), args)
                return cur.fetchall() if cur.description else cur.rowcount
            except Exception:
                if attempt: raise
                try: self.conn.close()
                except Exception: pass
                self._connect()

    def get(self, key):
        with self.lock:
            rows = self._q(f"SELECT pcm, sr FROM {TABLE} WHERE key = ?", (key,))
        return (bytes(rows[0][0]), int(rows[0][1])) if rows else None

    def put(self, key, pcm, sr):
        with self.lock:
            self._q(f"INSERT INTO {TABLE} (key, sr, pcm, size, created_at) VALUES (?, ?, ?, ?, ?) "
                    f"ON CONFLICT (key) DO UPDATE SET sr = excluded.sr, pcm = excluded.pcm, size = excluded.size, created_at = excluded.created_at",
                    (key, sr, pcm, len(pcm), time.time()))
            self.puts += 1
            if self.puts % 20 == 0: self._trim()

    def _trim(self):
        total = self._q(f"SELECT COALESCE(SUM(size), 0) FROM {TABLE}")[0][0]
        while total > self.cap:
            self._q(f"DELETE FROM {TABLE} WHERE key IN (SELECT key FROM {TABLE} ORDER BY created_at ASC LIMIT 50)")
            total = self._q(f"SELECT COALESCE(SUM(size), 0) FROM {TABLE}")[0][0]
            if not total: break

    def clear(self):
        with self.lock: return int(self._q(f"DELETE FROM {TABLE}") or 0)

    def usage(self):
        with self.lock: r = self._q(f"SELECT COUNT(*), COALESCE(SUM(size), 0) FROM {TABLE}")[0]
        return int(r[0]), int(r[1])


def make_store(cfg):
    """(store | None, error | None) from the config. Never raises: a bad URL just means no persistent tier (and says why)."""
    url = getattr(cfg, "CACHE_DB_URL", "")
    try:
        if url: return SqlStore(url, cfg.CACHE_DB_MB * 1048576), None
        if cfg.CACHE_DISK_MB: return DiskStore(cfg.CACHE_DIR, cfg.CACHE_DISK_MB * 1048576), None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"[:300]
    return None, None


# ------------------------------------------------------------------------------------------------ the cache
class AudioCache:
    def __init__(self, cfg_or_dir, mem_mb=128, disk_mb=512):
        if isinstance(cfg_or_dir, str):                                   # old signature (tests / scripts): AudioCache(dir, mem_mb, disk_mb)
            class _C: pass
            c = _C(); c.CACHE_DB_URL, c.CACHE_DB_MB, c.CACHE_DIR, c.CACHE_DISK_MB = "", 0, cfg_or_dir, disk_mb
            cfg_or_dir = c; self.mem_cap = mem_mb * 1048576
        else:
            self.mem_cap = cfg_or_dir.CACHE_MEM_MB * 1048576
        self._cfg = cfg_or_dir
        self._mem, self._mem_bytes, self._lock = OrderedDict(), 0, threading.Lock()
        self.hits = self.misses = 0
        self.store, self.store_error = make_store(cfg_or_dir)
        self.dir = getattr(cfg_or_dir, "CACHE_DIR", "")
        self._down_until = 0.0

    # ---- store access never raises and backs off for 30 s after a failure
    def _store_call(self, fn, *a):
        if not self.store or time.time() < self._down_until: return None
        try:
            r = fn(*a); self.store_error = None; return r
        except Exception as e:
            self.store_error = f"{type(e).__name__}: {e}"[:300]; self._down_until = time.time() + 30
            return None

    def get_mem(self, key):
        with self._lock:
            v = self._mem.get(key)
            if v is not None:
                self._mem.move_to_end(key); self.hits += 1
            return v

    def _get_store(self, key):
        v = self._store_call(self.store.get, key) if self.store else None
        with self._lock:
            if v is not None: self.hits += 1
            else: self.misses += 1
        if v is not None: self._put_mem(key, v)
        return v

    def get(self, key):                                                   # synchronous (memory, then the store)
        return self.get_mem(key) or self._get_store(key)

    async def aget(self, key):                                            # for the event loop: a database round trip must not block it
        v = self.get_mem(key)
        if v is not None or not self.store: 
            if v is None:
                with self._lock: self.misses += 1
            return v
        return await asyncio.to_thread(self._get_store, key)

    def _put_mem(self, key, v):
        with self._lock:
            if key in self._mem: return
            self._mem[key] = v; self._mem_bytes += len(v[0])
            while self._mem_bytes > self.mem_cap and self._mem:
                _, old = self._mem.popitem(last=False); self._mem_bytes -= len(old[0])

    def put(self, key, pcm: bytes, sr: int):
        self._put_mem(key, (pcm, sr))
        if self.store: self._store_call(self.store.put, key, pcm, sr)

    def clear(self):
        """Empty memory and the store. Returns how many persistent entries were removed."""
        with self._lock: self._mem.clear(); self._mem_bytes = 0; self.hits = self.misses = 0
        n = self._store_call(self.store.clear) if self.store else 0
        return n or 0

    def stats(self):
        n = self.hits + self.misses
        s = {"hits": self.hits, "misses": self.misses, "hit_rate": round(self.hits / n, 3) if n else None,
             "mem_items": len(self._mem), "mem_mb": round(self._mem_bytes / 1048576, 1), "disk": bool(self.store),
             "store": self.store.kind if self.store else None, "store_error": self.store_error}
        if self.store:
            u = self._store_call(self.store.usage)
            if u: s["store_items"], s["store_mb"] = u[0], round(u[1] / 1048576, 1)
        return s
