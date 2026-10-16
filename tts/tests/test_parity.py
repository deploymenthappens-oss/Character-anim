"""Python prep == the project's egy.js, on a fixed corpus plus seeded fuzz. Needs `node` on PATH (skipped otherwise)."""
import json, os, random, shutil, subprocess, sys
import unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from egy_tts import prep

ROOT = os.path.join(os.path.dirname(__file__), "..")
FIXED = [
    "ماذا تريد الآن؟ هل تستطيع المساعدة جداً", "سوف أقول لك غداً", "عندي meeting بكرة الساعة 3:30", "السعر 1,500 جنيه خصم 50%",
    "٣ ١٢ ٤٥٠٠ ٢٠٢٤", "عندك 2.75 كيلو و 0.5 لتر", "5:00 و 4:15 و 7:45 و 12:07 و 25:00", "1000000 و 999999 و 12345678901",
    "Hello Omar, welcome to the live stream! Thanks", "iPhone 15 Pro Max offer: 20% OFF", "USB AI TV pc VIP", "Charlie's change gym cage",
    "ازيك يا Mohamed 😀 هنبدأ الجيم", "", "   ", "لكن ليس هذا كل شيء، أيضاً الجميع رائع", "حسناً مرحباً شكراً كثيراً",
    "queue quite phone ghost knight echo", "unique umbrella orange ice ape",
]
ALPHA = list("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'’")
AR = "ماذا لماذا كيف أين هذا هذه الآن جداً كثيراً أريد نعم الذي ليس يوجد أيضاً لكن لأن اليوم غداً حسناً رائع فقط شيء سوف هل أستطيع مرحباً".split()
def fuzz(n=400, seed=7):
    r = random.Random(seed); out = []
    for _ in range(n):
        parts = []
        for _ in range(r.randint(1, 9)):
            k = r.random()
            if k < .3: parts.append(r.choice(AR))
            elif k < .5: parts.append("".join(r.choice(ALPHA) for _ in range(r.randint(1, 9))))
            elif k < .7: parts.append(str(r.choice([r.randint(0, 99), r.randint(0, 99999), r.randint(0, 99999999)])))
            elif k < .8: parts.append(f"{r.randint(0,26)}:{r.randint(0,70):02d}")
            elif k < .9: parts.append(f"{r.randint(0,99)}.{r.randint(0,999)}" + r.choice(["", "%", " %"]))
            else: parts.append(r.choice(["؟", "،", ".", "!", "1,234", "٧٨٩"]))
        out.append(r.choice([" ", "  ", ""]).join(parts) if r.random() < .1 else " ".join(parts))
    return out

def _parity():
    corpus = FIXED + fuzz()
    res = subprocess.run(["node", os.path.join(ROOT, "tools", "js_oracle.js")], input=json.dumps(corpus), capture_output=True, text=True, check=True)
    exp = json.loads(res.stdout)
    bad = []
    for t, e in zip(corpus, exp):
        got = {"numbers": prep.numbers_to_egy(t), "egyptianize": prep.egyptianize(t), "arabize": prep.arabize_latin(t),
               "speech_keep": prep.prepare_speech(t, True), "speech_arabized": prep.prepare_speech(t, False)}
        for k in got:
            if got[k] != e[k]: bad.append((t, k, got[k], e[k]))
    assert not bad, f"{len(bad)} mismatches, first: {bad[:3]}"

def _known():
    assert prep.numbers_to_egy("3:30") == "تلاتة ونص"
    assert prep.numbers_to_egy("50%") == "خمسين في المية"
    assert prep.numbers_to_egy("1500") == "ألف وخمسمية"
    assert prep.egyptianize("ماذا أريد الآن") == "إيه عايز دلوقتي"
    assert prep.prepare_speech("عندي meeting 5") == "عندي meeting خمسة"
    assert prep.prepare_speech("hello", keep_latin=False) == "هالو"


class Parity(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_python_matches_js(self): _parity()
    def test_known_values(self): _known()


if __name__ == "__main__":
    unittest.main()
