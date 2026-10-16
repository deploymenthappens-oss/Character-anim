"""Pipeline + server tests using the fake engine (no model, no network). Run: python -m unittest discover -s tests -t ."""
import asyncio, json, os, socket, subprocess, sys, tempfile, time, unittest, urllib.request, urllib.error, wave, io
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from egy_tts.config import Config
from egy_tts.pipeline import Pipeline, split_sentences
from egy_tts.engines import Engine, EngineError, ENGINE_CLASSES
import numpy as np

ROOT = os.path.join(os.path.dirname(__file__), "..")


def make_cfg(**kw):
    c = Config(); c.ENGINES = ["fake"]; c.CACHE_DIR = tempfile.mkdtemp(); c.FAKE_RTF = 0.0; c.TIMEOUT_S = 5; c.MIN_BUDGET_S = 0.2
    for k, v in kw.items(): setattr(c, k, v)
    return c


class SlowEngine(Engine):          # primary that never finishes in time
    name = "slow"
    def synth(self, *a, **k): time.sleep(1.5); return np.ones(4800, "float32") * .3, 24000
class BrokenEngine(Engine):
    name = "broken"
    def synth(self, *a, **k): raise EngineError("boom")


class Split(unittest.TestCase):
    def test_short_stays_whole(self): self.assertEqual(split_sentences("أهلا بيكم"), ["أهلا بيكم"])
    def test_sentences(self):
        out = split_sentences("ده أول جملة طويلة شوية كده. وده تاني جملة كمان طويلة. تمام")
        self.assertEqual(len(out), 2); self.assertTrue(out[1].endswith("تمام"))
    def test_hard_split_respects_max(self):
        out = split_sentences("كلمة " * 80, max_len=100)
        self.assertTrue(all(len(c) <= 100 for c in out)); self.assertGreater(len(out), 3)


class Pipe(unittest.TestCase):
    def run_async(self, coro): return asyncio.run(coro)

    def test_synth_and_cache(self):
        p = Pipeline(make_cfg())
        a = self.run_async(p.synthesize("عندي meeting الساعة 3:30"))
        self.assertTrue(a.wav[:4] == b"RIFF" and a.duration_ms > 300)
        self.assertIn("تلاتة ونص", a.spoken)                       # numbers were spoken-ified before the engine saw them
        b = self.run_async(p.synthesize("عندي meeting الساعة 3:30"))
        self.assertEqual((a.cache_hits, b.cache_hits), (0, b.chunks))
        self.assertEqual(a.wav, b.wav)

    def test_fallback_on_timeout_then_breaker_skips_primary(self):
        ENGINE_CLASSES["slow"] = SlowEngine
        c = make_cfg(ENGINES=["slow", "fake"], TIMEOUT_S=0.6, COOLDOWN_S=30)
        p = Pipeline(c)
        r = self.run_async(p.synthesize("جملة اختبار"))
        self.assertEqual(r.engines, ["fake"])
        self.assertEqual(p.slots[0].stats["timeout"], 1)
        t0 = time.time(); self.run_async(p.synthesize("جملة تانية خالص")); self.assertLess(time.time() - t0, 0.5)   # breaker open: no waiting on the slow engine

    def test_late_result_lands_in_cache(self):
        ENGINE_CLASSES["slow"] = SlowEngine
        p = Pipeline(make_cfg(ENGINES=["slow", "fake"], TIMEOUT_S=0.6, COOLDOWN_S=0))
        self.run_async(p.synthesize("جملة اختبار")); time.sleep(1.4)            # the slow job finishes in the background
        r = self.run_async(p.synthesize("جملة اختبار"))
        self.assertEqual(r.engines, ["slow"]); self.assertEqual(r.cache_hits, r.chunks)

    def test_queue_limit_goes_to_fallback(self):
        ENGINE_CLASSES["slow"] = SlowEngine
        p = Pipeline(make_cfg(ENGINES=["slow", "fake"], MAX_QUEUE=1, TIMEOUT_S=0.4, COOLDOWN_S=0))
        async def go():
            return await asyncio.gather(*[p.synthesize(f"جملة رقم {i} للاختبار") for i in range(4)])
        res = self.run_async(go())
        self.assertTrue(all(r.duration_ms > 0 for r in res))
        self.assertGreaterEqual(sum(r.engines == ["fake"] for r in res), 3)

    def test_all_engines_fail(self):
        ENGINE_CLASSES["broken"] = BrokenEngine
        p = Pipeline(make_cfg(ENGINES=["broken"]))
        with self.assertRaises(EngineError): self.run_async(p.synthesize("اختبار"))

    def test_empty_text(self):
        with self.assertRaises(ValueError): self.run_async(Pipeline(make_cfg()).synthesize("   "))


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = socket.socket(); s.bind(("127.0.0.1", 0)); cls.port = s.getsockname()[1]; s.close()
        env = dict(os.environ, ENGINES="fake", FAKE_RTF="0", PREWARM="0", KEEPALIVE_S="0", CACHE_DIR=tempfile.mkdtemp(), VOICETUT_TOKEN="sekret")
        cls.proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "egy_tts.server:app", "--port", str(cls.port), "--log-level", "warning"], cwd=ROOT, env=env)
        for _ in range(60):
            try: urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/health", timeout=1); break
            except Exception: time.sleep(.25)
    @classmethod
    def tearDownClass(cls): cls.proc.terminate(); cls.proc.wait(5)

    def call(self, path, body=None, method=None, token="sekret"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode() if body is not None else None, method=method,
                                     headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
        try:
            r = urllib.request.urlopen(req, timeout=20); return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e: return e.code, dict(e.headers), e.read()

    def test_health_open_tts_needs_token(self):
        self.assertEqual(self.call("/health", token=None)[0], 200)
        self.assertEqual(self.call("/tts", {"text": "ازيك"}, token=None)[0], 401)

    def test_tts_wav_and_headers_match_voicetut_js_contract(self):
        st, h, data = self.call("/tts", {"text": "أهلا بيكم في اللايف 50%"})
        self.assertEqual(st, 200); self.assertEqual(data[:4], b"RIFF")
        w = wave.open(io.BytesIO(data)); self.assertEqual((w.getnchannels(), w.getsampwidth()), (1, 2))
        self.assertAlmostEqual(int(h["x-duration-ms"]), w.getnframes() / w.getframerate() * 1000, delta=5)
        for k in ("x-sample-rate", "x-trim-lead-ms", "x-engine"): self.assertIn(k, h)

    def test_errors(self):
        self.assertEqual(self.call("/tts", {"text": " "})[0], 400)
        self.assertEqual(self.call("/tts", {"text": "x", "ref_id": "abcdef0123456789"})[0], 404)
        self.assertEqual(self.call("/ref/xyz", {"audio_b64": "A" * 200, "text": ""}, method="PUT")[0], 400)

    def test_prep_and_metrics(self):
        st, _, d = self.call("/prep", {"text": "ماذا أريد الآن 3:30 hello", "keep_latin": False}); j = json.loads(d)
        self.assertEqual(j["spoken"], "ماذا أريد الآن تلاتة ونص هالو"); self.assertEqual(j["egyptianized"], "إيه عايز دلوقتي 3:30 hello")
        self.call("/tts", {"text": "جملة للمقاييس"}); self.call("/tts", {"text": "جملة للمقاييس"})
        m = json.loads(self.call("/metrics")[2]); self.assertGreaterEqual(m["cache"]["hits"], 1); self.assertEqual(m["engines"][0]["name"], "fake")


if __name__ == "__main__":
    unittest.main()
