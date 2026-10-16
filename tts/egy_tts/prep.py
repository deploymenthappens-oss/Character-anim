"""Egyptian-Arabic text preparation. Faithful Python port of chat/egy.js (data tables are extracted from the JS by
tools/extract_tables.js, not retyped; tests/test_parity.py diffs this module against the JS on a corpus).

    egyptianize(text)       MSA words -> Egyptian wording, diacritics stripped
    numbers_to_egy(text)    digits -> Egyptian number words ("50%" -> "خمسين في المية", "3:30" -> "تلاتة ونص")
    arabize_latin(text)     Latin words -> Arabic letters (for voices that can't read English)
    prepare_speech(text, keep_latin=True)   the exact string sent to the TTS engine
"""
import json
import os
import re

_DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "egy_tables.json")
with open(_DATA, encoding="utf-8") as _f:
    _T = json.load(_f)

ONES, TEENS, TENS, HUND, THOUSAND_COUNT = (_T[k] for k in ("ONES", "TEENS", "TENS", "HUND", "THOUSAND_COUNT"))
MSA_TO_EGY, WORDS, LETTER_NAMES, SINGLE = _T["MSA_TO_EGY"], _T["WORDS"], _T["LETTER_NAMES"], _T["SINGLE"]
DIGRAPHS = [tuple(x) for x in _T["DIGRAPHS"]]

TASHKEEL = re.compile("[ً-ْٰـ]")
_L = "ء-يٱ-ۓ"
_ARABIC = re.compile("[؀-ۿ]")
_EASTERN = "٠١٢٣٤٥٦٧٨٩"


# ------------------------------------------------------------------ numbers
def _below1000(n: int) -> str:
    parts = []
    h, r = n // 100, n % 100
    if h:
        parts.append(HUND[h])
    if r:
        if r < 10:
            parts.append(ONES[r])
        elif r < 20:
            parts.append(TEENS[r - 10])
        else:
            u, t = r % 10, r // 10
            parts.append(f"{ONES[u]} و{TENS[t]}" if u else TENS[t])
    return " و".join(parts)


def int_to_egy(n: int) -> str:
    if n == 0:
        return ONES[0]
    if n >= 1_000_000:
        return str(n)  # same as the JS: too big to read out, the digits stay
    th, rest, parts = n // 1000, n % 1000, []
    if th:
        if th == 1:
            parts.append("ألف")
        elif th == 2:
            parts.append("ألفين")
        elif th <= 10:
            parts.append(f"{THOUSAND_COUNT[th]} تلاف")
        else:
            parts.append(f"{_below1000(th)} ألف")
    if rest:
        parts.append(_below1000(rest))
    return " و".join(parts)


def numbers_to_egy(text) -> str:
    s = re.sub("[٠-٩]", lambda m: str(_EASTERN.index(m.group(0))), str(text))
    s = s.replace("٫", ".")
    s = re.sub(r"([0-9]),([0-9]{3})(?![0-9])", r"\1\2", s)

    def clock(m):
        H, M = int(m.group(1)), int(m.group(2))
        if H > 24 or M > 59:
            return m.group(0)
        hh = int_to_egy(12 if H % 12 == 0 else H % 12)
        if M == 0:
            return hh
        if M == 30:
            return f"{hh} ونص"
        if M == 15:
            return f"{hh} وربع"
        if M == 45:
            return f"{hh} إلا ربع"
        return f"{hh} و{int_to_egy(M)}"

    s = re.sub(r"(?<![0-9])([0-9]{1,2}):([0-9]{2})(?![0-9])", clock, s)
    s = re.sub(r"([0-9]+(?:\.[0-9]+)?)\s*%", lambda m: f"{m.group(1)} في المية", s)
    s = re.sub(r"([0-9]+)\.([0-9]+)",
               lambda m: f"{int_to_egy(int(m.group(1)))} فاصل {' '.join(ONES[int(d)] for d in m.group(2))}", s)

    def whole(m):
        t = m.group(0)
        if len(t) > 7:
            return " ".join(ONES[int(d)] for d in t)
        return int_to_egy(int(t))

    return re.sub(r"[0-9]+", whole, s)


# ------------------------------------------------------------------ wording
_MSA_RE = [(re.compile(f"(?<![{_L}]){re.escape(a)}(?![{_L}])"), b) for a, b in MSA_TO_EGY if a != b]
_HAL_RE = re.compile("(^|[.!؟?،,؛]\\s*)هل\\s+")
_SOF_RE = re.compile(f"(?<![{_L}])سوف\\s+")


def egyptianize(text) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKC", TASHKEEL.sub("", str(text or "")))
    if not _ARABIC.search(s):
        return s.strip()
    s = _HAL_RE.sub(r"\1", s)
    s = _SOF_RE.sub("هـ", s)
    for rx, to in _MSA_RE:
        s = rx.sub(to, s)
    s = re.sub(r"هـ\s+", "هـ", s)
    s = re.sub("هـ([ء-ي])", r"ه\1", s)
    return re.sub(r"\s+", " ", s).strip()


# ------------------------------------------------------------------ Latin -> Arabic letters
def _arabize_word(w: str) -> str:
    lw = w.lower()
    if lw in WORDS:
        return WORDS[lw]
    if re.fullmatch("[A-Z]{2,4}", w):
        return " ".join(LETTER_NAMES[c] for c in lw)
    out, i, n = "", 0, len(lw)
    while i < n:
        d = next(((k, v) for k, v in DIGRAPHS if lw.startswith(k, i)), None)
        if d:
            out += d[1]
            i += len(d[0])
            continue
        c = lw[i]
        nxt = lw[i + 1] if i + 1 < n else ""
        if c == "c" and nxt and nxt in "eiy":
            out += "س"
        elif c == "g" and nxt and nxt in "eiy" and i > 0:
            out += "ج"
        elif i == 0 and c == "a":
            out += "أ"
        elif i == 0 and c == "e":
            out += "إ"
        elif i == 0 and c == "o":
            out += "أو"
        elif i == 0 and c == "u":
            out += "أو"
        elif i == 0 and c == "i":
            out += "إي"
        elif i == n - 1 and c == "e" and n > 3:
            pass  # silent final e
        else:
            out += SINGLE.get(c, "")
        i += 1
    return out or w


def arabize_latin(text) -> str:
    def one(m):
        w = re.sub("['’]s$", "", m.group(0), flags=re.I)
        return _arabize_word(re.sub("['’]", "", w))
    return re.sub("[A-Za-z][A-Za-z'’]*", one, str(text))


# ------------------------------------------------------------------ one call
def prepare_speech(text, keep_latin: bool = True) -> str:
    """keep_latin=True for VoiceTut (it reads English itself); False for voices that can't (Edge ar-EG)."""
    s = numbers_to_egy(TASHKEEL.sub("", str(text or "")))
    if not keep_latin:
        s = arabize_latin(s)
    return re.sub(r"\s+", " ", s).strip()
