import os, sys, unittest, wave, struct
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from egy_tts.config import Config
from egy_tts.engines import VoiceTutEngine


class StubTTS:
    def __init__(self, strict=False): self.calls, self.strict = [], strict
    def synthesize(self, text, output=None, **kw):
        if self.strict and "ref_audio" in kw and "ref_text" not in kw: raise TypeError("synthesize() missing required argument: 'ref_text'")
        self.calls.append(kw)
        with wave.open(output, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(struct.pack("<h", 0) * 2400)


class CloneNoTranscript(unittest.TestCase):
    def eng(self, strict):
        e = VoiceTutEngine(Config()); e._tts = StubTTS(strict); return e

    def test_empty_transcript_is_omitted(self):
        e = self.eng(False); e.synth("اهلا", ref=("/x.wav", ""))
        self.assertNotIn("ref_text", e._tts.calls[0]); self.assertEqual(e._tts.calls[0]["ref_audio"], "/x.wav")

    def test_real_transcript_is_sent(self):
        e = self.eng(False); e.synth("اهلا", ref=("/x.wav", "كلام الملف"))
        self.assertEqual(e._tts.calls[0]["ref_text"], "كلام الملف")

    def test_retry_with_placeholder_if_model_demands_it(self):
        e = self.eng(True); e.synth("اهلا", ref=("/x.wav", ""))
        self.assertEqual(e._tts.calls[0]["ref_text"], ".")
