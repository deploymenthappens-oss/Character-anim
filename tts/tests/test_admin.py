"""Admin dashboard/API tests against a real server process (fake engine, fake stream server). python -m unittest discover -s tests -t ."""
import json, os, socket, subprocess, sys, tempfile, threading, time, unittest, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

ROOT = os.path.join(os.path.dirname(__file__), "..")
ADM, SVC, STR = "adm-secret-123", "svc-token", "stream-secret"


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class FakeStream(BaseHTTPRequestHandler):
    seen = []
    def log_message(self, *a): pass
    def _do(self):
        n = int(self.headers.get("Content-Length") or 0); body = self.rfile.read(n).decode() if n else ""
        FakeStream.seen.append((self.command, self.path, self.headers.get("Authorization"), body))
        out = {"engine": "voicetut", "current": {"vt": "Mohamed"}, "voicetut": {"up": True, "speakers": [{"name": "Mohamed"}, {"name": "Asmaa"}]}} if self.path == "/voices" else {"ok": True}
        raw = json.dumps(out).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    do_GET = do_POST = _do


def start(env_extra):
    port = free_port()
    env = dict(os.environ, ENGINES="fake", FAKE_RTF="0", PREWARM="0", KEEPALIVE_S="0", CACHE_DIR=tempfile.mkdtemp(), **env_extra)
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "egy_tts.server:app", "--port", str(port), "--log-level", "warning"], cwd=ROOT, env=env)
    for _ in range(80):
        try: urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1); break
        except Exception: time.sleep(.25)
    return proc, port


def call(port, path, body=None, method=None, headers=None, bearer=None, cookie=None, csrf=False):
    h = {"Content-Type": "application/json", **(headers or {})}
    if bearer: h["Authorization"] = "Bearer " + bearer
    if cookie: h["Cookie"] = cookie
    if csrf: h["X-Requested-With"] = "egy-admin"
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=20); return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def J(t): return json.loads(t[2])


class AdminOn(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), FakeStream); threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.settings_file = os.path.join(tempfile.mkdtemp(), "settings.json")
        cls.proc, cls.port = start(dict(ADMIN_TOKEN=ADM, VOICETUT_TOKEN=SVC, SETTINGS_FILE=cls.settings_file,
                                        STREAM_URL=f"http://127.0.0.1:{cls.srv.server_address[1]}", STREAM_ADMIN_TOKEN=STR))
    @classmethod
    def tearDownClass(cls): cls.proc.terminate(); cls.proc.wait(5); cls.srv.shutdown()

    def A(self, path, body=None, method=None, **kw): return call(self.port, "/admin/api" + path, body, method, bearer=ADM, **kw)

    # ---- auth
    def test_auth_matrix(self):
        self.assertEqual(call(self.port, "/admin/api/status")[0], 401)
        self.assertEqual(call(self.port, "/admin/api/status", bearer="nope")[0], 401)
        self.assertEqual(call(self.port, "/admin/api/status", bearer=SVC)[0], 401)          # the service token must NOT open the admin API
        self.assertEqual(call(self.port, "/admin/api/status", bearer=ADM)[0], 200)
        self.assertEqual(call(self.port, "/tts", {"text": "ازيك"}, bearer=ADM)[0], 401)       # and the admin token is not the service token
        self.assertEqual(call(self.port, "/admin/docs")[0], 401)
        self.assertEqual(call(self.port, "/admin/docs", bearer=ADM)[0], 200)

    def test_cookie_login_flow_and_csrf(self):
        self.assertEqual(call(self.port, "/admin/api/login", {"token": "wrong"}, "POST")[0], 401)
        st, h, _ = call(self.port, "/admin/api/login", {"token": ADM}, "POST"); self.assertEqual(st, 200)
        sc = h["Set-Cookie"]; self.assertIn("HttpOnly", sc); self.assertIn("SameSite=strict", sc.replace("Strict", "strict")); self.assertNotIn(ADM, sc)
        cookie = sc.split(";")[0]
        self.assertEqual(call(self.port, "/admin/api/status", cookie=cookie)[0], 200)
        self.assertEqual(call(self.port, "/admin/api/cache", method="DELETE", cookie=cookie)[0], 403)                 # no CSRF header
        self.assertEqual(call(self.port, "/admin/api/cache", method="DELETE", cookie=cookie, csrf=True)[0], 200)
        name, val = cookie.split("=", 1); payload, sig = val.split(".")
        self.assertEqual(call(self.port, "/admin/api/status", cookie=f"{name}={payload}.{sig[:-2]}AA")[0], 401)       # tampered signature
        self.assertEqual(call(self.port, "/admin/api/probe", cookie=cookie)[0], 200)
        self.assertTrue(J(call(self.port, "/admin/api/probe", cookie=cookie))["authenticated"])

    def test_lockout(self):
        h = {"X-Forwarded-For": "9.9.9.9"}
        codes = [call(self.port, "/admin/api/login", {"token": "x"}, "POST", headers=h)[0] for _ in range(6)]
        self.assertEqual(codes[:5], [401] * 5); self.assertEqual(codes[5], 429)
        self.assertEqual(call(self.port, "/admin/api/login", {"token": ADM}, "POST", headers=h)[0], 429)                # even the right token is refused in the window
        self.assertEqual(call(self.port, "/admin/api/login", {"token": ADM}, "POST", headers={"X-Forwarded-For": "8.8.8.8"})[0], 200)

    def test_dashboard_page_public_with_hardening_headers(self):
        st, h, body = call(self.port, "/admin")
        self.assertEqual(st, 200); self.assertIn(b"TTS admin", body); self.assertIn("default-src 'self'", h["Content-Security-Policy"]); self.assertEqual(h["X-Frame-Options"], "DENY")
        self.assertNotIn(ADM.encode(), body)

    # ---- settings
    def test_settings_validate_apply_persist_reset(self):
        st = self.A("/settings", {"SPEED": 5}, "PATCH"); self.assertEqual(st[0], 400); self.assertIn("SPEED", J(st)["errors"])
        st = self.A("/settings", {"SPEED": 1.1, "BOGUS": 1}, "PATCH"); self.assertEqual(st[0], 400)                    # all-or-nothing
        self.assertEqual(J(self.A("/settings"))["SPEED"]["value"], 1.0)
        self.assertEqual(self.A("/settings", {"SPEED": 1.1, "NUM_STEP": "8", "EDGE_RATE": "+10%"}, "PATCH")[0], 200)
        s = J(self.A("/settings")); self.assertEqual((s["SPEED"]["value"], s["NUM_STEP"]["value"], s["SPEED"]["overridden"]), (1.1, 8, True))
        saved = json.load(open(self.settings_file)); self.assertEqual(saved["settings"]["SPEED"], 1.1)
        self.assertEqual(self.A("/settings", {"EDGE_RATE": "fast"}, "PATCH")[0], 400)
        self.assertEqual(self.A("/settings/reset", {}, "POST")[0], 200)
        self.assertEqual(J(self.A("/settings"))["SPEED"]["value"], 1.0); self.assertEqual(json.load(open(self.settings_file))["settings"], {})
        self.assertTrue(any("settings changed" in e["msg"] for e in J(self.A("/events"))))

    # ---- logs
    def test_logs_require_auth_and_follow_a_cursor(self):
        self.assertEqual(call(self.port, "/admin/api/logs")[0], 401)
        self.assertEqual(call(self.port, "/admin/api/logs", bearer=SVC)[0], 401)
        self.assertEqual(call(self.port, "/admin/api/stream/logs")[0], 401)
        self.assertEqual(call(self.port, "/admin/api/status", bearer=ADM)[0], 200)
        self.A("/test", {"text": "ازيك يا باشا", "cache": False}, "POST")                                           # one real request through the pipeline
        j = J(self.A("/logs")); self.assertEqual(j["service"], "tts"); self.assertTrue(j["boot"])
        ids = [e["id"] for e in j["items"]]; self.assertEqual(ids, sorted(ids))
        self.assertTrue(any(e["msg"].startswith("tts ok ") for e in j["items"]))
        self.assertTrue(all(set(e) == {"id", "t", "level", "src", "msg"} and e["src"] == "tts" for e in j["items"]))
        self.assertEqual(J(self.A(f"/logs?since={j['next']}"))["items"], [])                                          # nothing newer than the cursor
        self.A("/settings", {"SPEED": 1.2}, "PATCH"); self.A("/settings/reset", {}, "POST")
        new = J(self.A(f"/logs?since={j['next']}"))["items"]; self.assertTrue(any("settings changed" in e["msg"] for e in new))
        self.assertTrue(all(e["level"] in ("warn", "error") for e in J(self.A("/logs?level=warn"))["items"]))
        self.assertLessEqual(len(J(self.A("/logs?limit=2"))["items"]), 2)
        self.assertEqual(self.A("/logs?since=abc&level=bogus&limit=x")[0], 200)                                       # junk query values fall back to defaults

    def test_stream_logs_proxy_uses_stream_token(self):
        FakeStream.seen.clear()
        self.assertEqual(self.A("/stream/logs?since=7&level=warn&limit=50")[0], 200)
        self.assertIn(("GET", "/logs?since=7&level=warn&limit=50", "Bearer " + STR, ""), FakeStream.seen)

    # ---- engines
    def test_engines(self):
        e = {x["name"]: x for x in J(self.A("/engines"))}
        self.assertTrue(e["fake"]["enabled"]); self.assertFalse(e["espeak"]["enabled"])
        self.assertEqual(self.A("/engines/fake/disable", {}, "POST")[0], 400)                                           # last enabled engine stays
        self.assertEqual(self.A("/engines/nope/enable", {}, "POST")[0], 404)
        self.assertEqual(self.A("/engines/espeak/enable", {}, "POST")[0], 200)
        self.assertEqual(self.A("/engines/fake/reset", {}, "POST")[0], 200)
        self.assertEqual(self.A("/engines/espeak/reload", {}, "POST")[0], 400)
        self.assertEqual(self.A("/engines/order", {"order": ["espeak", "nonsense"]}, "PUT")[0], 400)
        self.assertEqual(J(self.A("/engines/order", {"order": ["fake", "espeak", "edge", "voicetut"]}, "PUT"))["order"][0], "fake")
        self.A("/engines/espeak/disable", {}, "POST")
        saved = json.load(open(self.settings_file)); self.assertIn("espeak", saved["engines"]["disabled"])

    # ---- activity / test / cache / phrases
    def test_speak_log_cache_phrases(self):
        st, h, wav = self.A("/test", {"text": "جملة من لوحة التحكم 3:30", "cache": True}, "POST")
        self.assertEqual(st, 200); self.assertEqual(wav[:4], b"RIFF"); self.assertIn("X-Engine", h)
        log = J(self.A("/requests?limit=5")); self.assertTrue(log[0]["ok"]); self.assertIn("جملة", log[0]["text"])
        self.assertEqual(self.A("/test", {"text": "  "}, "POST")[0], 400)
        self.assertGreaterEqual(J(self.A("/status"))["totals"]["requests"], 1)
        self.A("/test", {"text": "جملة من لوحة التحكم 3:30"}, "POST"); self.assertGreaterEqual(J(self.A("/cache"))["hits"], 1)
        self.assertGreaterEqual(J(self.A("/cache", None, "DELETE"))["files_removed"], 1); self.assertEqual(J(self.A("/cache"))["hits"], 0)
        self.assertEqual(self.A("/phrases", {"text": "# c\nتمام\nحاضر"}, "PUT")[0], 200); self.assertIn("حاضر", J(self.A("/phrases"))["text"])
        self.assertEqual(self.A("/phrases", {"text": "x"}, "PUT").__getitem__(0), 200)
        self.assertIn("تلاتة ونص", J(self.A("/prep", {"text": "3:30"}, "POST"))["spoken"])

    def test_status_shape(self):
        s = J(self.A("/status"))
        for k in ("engines", "cache", "totals", "system", "order", "uptime_s", "stream_configured"): self.assertIn(k, s)
        self.assertTrue(s["stream_configured"]); self.assertGreaterEqual(s["system"]["cpus"], 1)

    # ---- stream proxy
    def test_stream_proxy_and_allowlist(self):
        FakeStream.seen.clear()
        v = J(self.A("/stream/voices")); self.assertEqual(v["current"]["vt"], "Mohamed")
        self.assertEqual(FakeStream.seen[-1], ("GET", "/voices", "Bearer " + STR, ""))
        self.A("/stream/voice", {"vt": "Asmaa", "evil": "x", "en": 5}, "POST")
        self.assertEqual(json.loads(FakeStream.seen[-1][3]), {"vt": "Asmaa"})                                           # only known string keys are forwarded
        self.assertEqual(self.A("/stream/speech/pause", {}, "POST")[0], 200); self.assertEqual(FakeStream.seen[-1][1], "/speech/pause")
        self.assertEqual(self.A("/stream/speech/explode", {}, "POST")[0], 400)
        self.assertEqual(self.A("/stream/../admin/login", None)[0], 404)

    def test_docs_cover_every_route(self):
        spec = J(self.A("/openapi.json"))["paths"]
        from egy_tts import admin
        for r in admin._routes:
            self.assertIn(r.path, spec, r.path)
        for p in ("/tts", "/health", "/admin/api/login"): self.assertIn(p, spec)
        html = call(self.port, "/admin/docs", bearer=ADM)[2].decode(); self.assertIn("/admin/api/engines/{name}/{action}", html); self.assertIn("ADMIN_TOKEN", html)


class AdminOff(unittest.TestCase):
    def test_disabled_without_token(self):
        proc, port = start({})
        try:
            self.assertEqual(call(port, "/admin/api/status")[0], 503)
            self.assertEqual(call(port, "/admin/api/status", bearer="")[0], 503)
            self.assertEqual(call(port, "/admin/api/login", {"token": ""}, "POST")[0], 503)                              # an empty token must never log in
            self.assertEqual(call(port, "/admin")[0], 200)
            self.assertFalse(J(call(port, "/admin/api/probe"))["enabled"])
        finally: proc.terminate(); proc.wait(5)


if __name__ == "__main__":
    unittest.main()


class TokenShapes(unittest.TestCase):
    """Tokens come ONLY from environment variables, may be any length, and Railway-style padding/quotes must not matter."""
    def run_with(self, admin_env, svc_env, good_admin, good_svc):
        proc, port = start(dict(ADMIN_TOKEN=admin_env, VOICETUT_TOKEN=svc_env, SETTINGS_FILE=os.path.join(tempfile.mkdtemp(), "s.json")))
        try:
            self.assertEqual(call(port, "/admin/api/status", bearer=good_admin)[0], 200)
            self.assertEqual(call(port, "/tts", {"text": "ازيك"}, bearer=good_svc)[0], 200)
            self.assertEqual(call(port, "/admin/api/login", {"token": good_admin}, "POST")[0], 200)
            self.assertEqual(call(port, "/admin/api/status", bearer=good_admin + "x")[0], 401)
            self.assertEqual(call(port, "/admin/api/status", bearer=good_admin[:-1])[0], 401)   # a prefix of the real token never works
        finally:
            proc.terminate(); proc.wait(5)

    def test_very_long_token(self):
        t = "Zq9!" * 500                                              # 2000 chars, symbols included
        self.run_with(t, t[::-1], t, t[::-1])

    def test_one_char_token_still_works(self):
        self.run_with("a", "b", "a", "b")

    def test_env_padding_and_quotes_are_ignored(self):
        self.run_with('  "my secret with spaces"\n', "'svc-quoted'  ", "my secret with spaces", "svc-quoted")

    def test_bearer_lockout(self):
        proc, port = start(dict(ADMIN_TOKEN="right-token", SETTINGS_FILE=os.path.join(tempfile.mkdtemp(), "s.json")))
        try:
            codes = [call(port, "/admin/api/status", bearer=f"guess{i}")[0] for i in range(7)]
            self.assertEqual(codes[:5], [401] * 5); self.assertEqual(codes[5], 429)
            self.assertEqual(call(port, "/admin/api/status", bearer="right-token")[0], 429)     # locked for the window even with the right one
        finally:
            proc.terminate(); proc.wait(5)

    def test_config_reads_env_live(self):
        from egy_tts.config import Config, clean, secret_equal
        c = Config(); os.environ["ADMIN_TOKEN"] = " first "
        try:
            self.assertEqual(c.ADMIN_TOKEN, "first"); os.environ["ADMIN_TOKEN"] = "second"; self.assertEqual(c.ADMIN_TOKEN, "second")   # no restart/code change
        finally: os.environ.pop("ADMIN_TOKEN", None)
        self.assertFalse(secret_equal("", "")); self.assertTrue(secret_equal('"x y"', "x y")); self.assertEqual(clean(None), "")


class LogRedaction(unittest.TestCase):
    def test_secrets_never_reach_the_buffer(self):
        from egy_tts import logbuf
        os.environ["SOME_API_TOKEN"] = "supersecretvalue123"
        try:
            logbuf.log.info("auth header was Authorization: Bearer abc123def456ghi and token=hunter2hunter2 and supersecretvalue123 and sk-abcdefghijklmnop1234")
            msg = logbuf.read(0, "debug", 5)["items"][-1]["msg"]
        finally:
            del os.environ["SOME_API_TOKEN"]
        for leaked in ("abc123def456ghi", "hunter2hunter2", "supersecretvalue123", "sk-abcdefghijklmnop1234"):
            self.assertNotIn(leaked, msg)
        self.assertIn("Bearer ***", msg)
