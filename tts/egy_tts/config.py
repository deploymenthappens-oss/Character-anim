"""All settings come from environment variables (same names as the existing voicetut service where they overlap)."""
import hashlib
import hmac
import os


def clean(v):
    """Railway / .env values often arrive with a trailing newline, spaces or one layer of quotes from copy-paste. Normalise them."""
    v = str(v if v is not None else "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v


def secret_equal(a, b):
    """Constant-time comparison of two secrets of ANY length (both are hashed first, so length leaks nothing). Empty never matches."""
    a, b = clean(a), clean(b)
    if not a or not b: return False
    return hmac.compare_digest(hashlib.sha256(a.encode()).digest(), hashlib.sha256(b.encode()).digest())


def _i(k, d): return int(clean(os.environ.get(k, d)))
def _f(k, d): return float(clean(os.environ.get(k, d)))
def _s(k, d=""): return clean(os.environ.get(k, d))
def _b(k, d): return clean(os.environ.get(k, "1" if d else "0")).lower() in ("1", "true", "yes", "on")


class EnvVar:
    """A setting read from the environment EVERY time it is used (not frozen at import), so a token changed in Railway / the shell
    takes effect with no code change; assigning to it on an instance (tests, scripts) overrides the environment for that instance."""
    def __init__(self, name, default="", strip_slash=False): self.name, self.default, self.strip_slash = name, default, strip_slash
    def __set_name__(self, owner, name): self.attr = "_ov_" + name
    def __get__(self, obj, owner=None):
        if obj is None: return self
        if self.attr in obj.__dict__: return obj.__dict__[self.attr]
        v = _s(self.name, self.default)
        return v.rstrip("/") if self.strip_slash else v
    def __set__(self, obj, value): obj.__dict__[self.attr] = value


class _DbUrl:
    """CACHE_DATABASE_URL, else DATABASE_URL (what Railway's Postgres reference variable is usually called). CACHE_DB=off ignores both."""
    def __set_name__(self, owner, name): self.attr = "_ov_" + name
    def __get__(self, obj, owner=None):
        if obj is None: return self
        if self.attr in obj.__dict__: return obj.__dict__[self.attr]
        if _s("CACHE_DB", "auto").lower() in ("off", "0", "false", "no"): return ""
        return _s("CACHE_DATABASE_URL") or _s("DATABASE_URL")
    def __set__(self, obj, value): obj.__dict__[self.attr] = value


class Config:
    # ---- engines: first = preferred, the rest are fallbacks tried in order when it is down / slow / overloaded
    ENGINES = [e.strip() for e in _s("ENGINES", "voicetut,edge,espeak").split(",") if e.strip()]
    TOKEN = EnvVar("VOICETUT_TOKEN")                         # optional bearer token for every endpoint except /health
    # ---- VoiceTut
    REPO = _s("VOICETUT_REPO", "mohammedaly22/VoiceTut-TTS")
    SPEAKER = _s("VOICETUT_SPEAKER", "Mohamed")
    NUM_STEP = _s("VOICETUT_NUM_STEP", "auto")           # "auto": 12 on CPU, 32 on GPU. Lower = faster, rougher
    GUIDANCE = _f("VOICETUT_GUIDANCE", 2.5)
    SPEED = _f("VOICETUT_SPEED", 1.0)
    THREADS = _i("TORCH_THREADS", 0)                     # 0 = leave torch default (= all cores)
    # ---- request budget / backpressure
    MAX_CHARS = _i("VOICETUT_MAX_CHARS", 600)
    TIMEOUT_S = _f("TTS_TIMEOUT_S", 25)                  # whole request; the primary engine gets what is left, then a fallback answers
    MAX_QUEUE = _i("TTS_MAX_QUEUE", 3)                   # jobs waiting on the primary engine; beyond this chunks go straight to a fallback
    MIN_BUDGET_S = _f("TTS_MIN_BUDGET_S", 1.0)           # less time than this left for a request: do not even start the preferred engine
    COOLDOWN_S = _f("TTS_COOLDOWN_S", 8)                 # after a primary failure/timeout skip it this long
    # ---- text -> chunks
    CHUNK_MAX = _i("CHUNK_MAX_CHARS", 160)
    CHUNK_MIN = _i("CHUNK_MIN_CHARS", 24)
    GAP_MS = _i("CHUNK_GAP_MS", 120)                     # silence inserted between sentences
    PAD_MS = _i("VOICETUT_PAD_MS", 60)                   # silence kept around the speech after trimming
    # ---- cache
    CACHE_DIR = _s("CACHE_DIR", os.path.join(os.environ.get("TMPDIR", "/tmp"), "egy_tts_cache"))
    CACHE_MEM_MB = _i("CACHE_MEM_MB", 128)
    # a database instead of files: set CACHE_DATABASE_URL (or Railway's DATABASE_URL) to postgres://... or sqlite:///file.db. It wins over CACHE_DIR.
    CACHE_DB_URL = _DbUrl()
    CACHE_DB_MB = _i("CACHE_DB_MB", 512)                 # size cap for the database tier (oldest entries are deleted first)
    CACHE_DISK_MB = _i("CACHE_DISK_MB", 512)             # 0 disables the disk tier (mount a volume at CACHE_DIR to survive restarts)
    # ---- background activity
    WARMUP = _b("WARMUP", True)                          # load the model + one real generation at startup
    PREWARM = _b("PREWARM", True)                        # pre-render data/phrases.txt into the cache while idle
    KEEPALIVE_S = _i("KEEPALIVE_S", 240)                 # 0 disables; when idle this long, run a tiny generation so weights stay hot
    LOG_TEXT = _b("LOG_TEXT", True)                      # keep the first 60 chars of each request in the admin log (set 0 for privacy)
    # ---- admin dashboard + API (disabled unless ADMIN_TOKEN is set; NOT the same secret as VOICETUT_TOKEN)
    ADMIN_TOKEN = EnvVar("ADMIN_TOKEN")
    ADMIN_SESSION_HOURS = _f("ADMIN_SESSION_HOURS", 12)
    SETTINGS_FILE = _s("SETTINGS_FILE", os.path.join(os.environ.get("TMPDIR", "/tmp"), "egy_tts_settings.json"))   # runtime overrides (put it on the /data volume)
    PHRASES_FILE = _s("PHRASES_FILE", "")                # editable phrase list; default: <SETTINGS_FILE dir>/phrases.txt, seeded from the packaged one
    STREAM_URL = EnvVar("STREAM_URL", strip_slash=True)            # your Node stream server (publish/view); lets the dashboard drive its voice settings
    STREAM_ADMIN_TOKEN = EnvVar("STREAM_ADMIN_TOKEN")        # that server's ADMIN_TOKEN
    # ---- fallbacks
    EDGE_VOICE = _s("EDGE_VOICE", "ar-EG-SalmaNeural")
    EDGE_RATE = _s("EDGE_RATE", "+0%")
    ESPEAK_VOICE = _s("ESPEAK_VOICE", "ar")
    REF_DIR = _s("VOICETUT_REF_DIR", os.path.join(os.environ.get("TMPDIR", "/tmp"), "voicetut_refs"))
    FAKE_RTF = _f("FAKE_RTF", 0.2)                       # fake engine (tests / UI work): simulated real-time factor
