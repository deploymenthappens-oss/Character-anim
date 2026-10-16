import asyncio, os, sys, tempfile, time, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from egy_tts.cache import AudioCache, SqlStore, DiskStore, make_key
from egy_tts.config import Config


def cfg(**kw):
    c = Config()
    for k, v in kw.items(): setattr(c, k, v)
    return c


class DbCache(unittest.TestCase):
    def setUp(self):
        self.db = os.path.join(tempfile.mkdtemp(), "sub", "cache.db"); self.url = "sqlite:///" + self.db

    def test_survives_a_new_process_and_clears(self):
        c1 = AudioCache(cfg(CACHE_DB_URL=self.url)); self.assertEqual(c1.store.kind, "sqlite")
        c1.put("k1", b"\x01\x00" * 100, 24000)
        c2 = AudioCache(cfg(CACHE_DB_URL=self.url))                        # "redeploy": empty memory, same database
        self.assertEqual(c2.get("k1"), (b"\x01\x00" * 100, 24000))
        st = c2.stats(); self.assertEqual((st["store"], st["store_items"], st["hits"]), ("sqlite", 1, 1))
        self.assertEqual(c2.clear(), 1); self.assertIsNone(c2.get("k1"))

    def test_async_get_and_overwrite(self):
        c = AudioCache(cfg(CACHE_DB_URL=self.url)); c.put("a", b"1111", 1); c.put("a", b"2222", 2)
        c2 = AudioCache(cfg(CACHE_DB_URL=self.url))
        self.assertEqual(asyncio.run(c2.aget("a")), (b"2222", 2)); self.assertIsNone(asyncio.run(c2.aget("zzz")))

    def test_size_cap_deletes_oldest(self):
        s = SqlStore(self.url, 4000)
        for i in range(60): s.put(f"k{i:02d}", b"x" * 200, 1); time.sleep(0.001)
        n, size = s.usage(); self.assertLessEqual(size, 4000 + 20 * 200); s._trim(); n, size = s.usage(); self.assertLessEqual(size, 4000)
        self.assertIsNone(s.get("k00")); self.assertIsNotNone(s.get("k59"))

    def test_bad_url_never_breaks_the_service(self):
        c = AudioCache(cfg(CACHE_DB_URL="mysql://nope")); self.assertIsNone(c.store); self.assertIn("must start with", c.store_error)
        c.put("k", b"zz", 1); self.assertEqual(c.get("k"), (b"zz", 1))      # memory tier still works

    def test_runtime_failure_fails_open_and_backs_off(self):
        c = AudioCache(cfg(CACHE_DB_URL=self.url)); c.put("k", b"zz", 1)
        c.store.conn.close(); c.store._connect = lambda: (_ for _ in ()).throw(RuntimeError("db down"))
        c2 = AudioCache(cfg(CACHE_DB_URL=self.url)); c2.store.conn.close(); c2.store._connect = c.store._connect
        self.assertIsNone(c2.get("k")); self.assertIn("db down", c2.store_error)
        c2.put("n", b"yy", 1); self.assertEqual(c2.get("n"), (b"yy", 1))     # served from memory while the database is down
        self.assertGreater(c2._down_until, time.time())

    def test_selection_from_env(self):
        keep = {k: os.environ.pop(k, None) for k in ("CACHE_DATABASE_URL", "DATABASE_URL", "CACHE_DB")}
        try:
            self.assertEqual(Config().CACHE_DB_URL, "")
            os.environ["DATABASE_URL"] = " 'postgres://u:p@h/db' \n"; self.assertEqual(Config().CACHE_DB_URL, "postgres://u:p@h/db")
            os.environ["CACHE_DATABASE_URL"] = self.url; self.assertEqual(Config().CACHE_DB_URL, self.url)     # the specific variable wins
            os.environ["CACHE_DB"] = "off"; self.assertEqual(Config().CACHE_DB_URL, "")
        finally:
            for k in keep: os.environ.pop(k, None)
            os.environ.update({k: v for k, v in keep.items() if v is not None})

    def test_default_is_disk_tier(self):
        d = tempfile.mkdtemp(); c = AudioCache(d, 8, 8); self.assertIsInstance(c.store, DiskStore); c.put("q", b"ab", 5)
        self.assertEqual(AudioCache(d, 8, 8).get("q"), (b"ab", 5))


class ServiceWithDb(unittest.TestCase):
    def test_service_caches_in_the_database(self):
        from tests.test_admin import start, call, J
        db = os.path.join(tempfile.mkdtemp(), "svc.db")
        proc, port = start(dict(ADMIN_TOKEN="a", CACHE_DATABASE_URL="sqlite:///" + db, SETTINGS_FILE=os.path.join(tempfile.mkdtemp(), "s.json")))
        try:
            self.assertEqual(call(port, "/tts", {"text": "ازيك يا باشا عامل ايه"})[0], 200)
            st, h, _ = call(port, "/tts", {"text": "ازيك يا باشا عامل ايه"}); self.assertEqual(h["X-Cache-Hits"].split("/")[0], h["X-Chunks"])
            c = J(call(port, "/admin/api/cache", bearer="a")); self.assertEqual(c["store"], "sqlite"); self.assertGreaterEqual(c["store_items"], 1)
            self.assertEqual(call(port, "/admin/api/cache", method="DELETE", bearer="a")[0], 200)
            self.assertEqual(J(call(port, "/admin/api/cache", bearer="a"))["store_items"], 0)
        finally:
            proc.terminate(); proc.wait(5)
