# VoiceTut TTS service

Gives the avatar one natural **Egyptian-Arabic voice that also reads English** (code-switching such as
"عندي meeting بكرة"), using [mohammedaly22/VoiceTut-TTS](https://huggingface.co/mohammedaly22/VoiceTut-TTS)
(Apache-2.0, 0.6B, 24 kHz, 15-17 built-in speakers, optional voice cloning with consent).

It is a separate service because the model is PyTorch and wants a GPU (model card: ~1.1x real time and 2.9 GB VRAM on a T4).
The Railway/Node container just calls it over HTTP (`chat/voicetut.js`). **If it is down or slow, each line falls back to
Edge TTS and then espeak-ng**, so the stream never goes silent.

## Run it
GPU box (RunPod, Vast, your own PC with Docker + NVIDIA toolkit):

    docker build -t voicetut ./voicetut
    docker run --gpus all -p 8000:8000 -e VOICETUT_TOKEN=pick-a-secret -v voicetut-models:/models voicetut

or with the compose file: `docker compose --profile gpu up -d`.
Without Docker: `pip install torch ...; pip install git+https://github.com/k2-fsa/OmniVoice.git; pip install -r requirements.txt; uvicorn app:app --port 8000`.
First start downloads the model and warms it up (watch for `[voicetut] warm`). `GET /health` shows `loaded`, `device`.

## Point the stream at it
On the chat server (Railway variables or `.env`):

    VOICETUT_URL=https://your-gpu-host:8000      # setting this switches TTS_ENGINE to voicetut automatically
    VOICETUT_TOKEN=pick-a-secret
    VOICETUT_SPEAKER=Mohamed                     # default; changeable live in publish.html > Voice
    VOICETUT_TIMEOUT_MS=30000                    # slower than this -> that line falls back to Edge

Service tuning: `VOICETUT_NUM_STEP` (32; 48 = nicer, slower), `VOICETUT_GUIDANCE` (2.5), `VOICETUT_SPEED` (1.0).

## Lip-sync
The model returns audio only (no word timestamps). The service trims leading/trailing silence and reports the exact duration;
the browser's lip-sync (`web/lipsync.js`) then aligns Arabic and English letters to the *real* audio envelope (voiced bursts and
pauses), so the mouth opens when the voice starts, closes in pauses and stops when it stops.

## Notes
- Latency: first audio ~1.7 s on a T4 for a short line. The instant "acknowledgement" line before a reply is also spoken by VoiceTut, so expect a short pause on a slow GPU.
- Not tested against the real model by the author of this patch (no GPU / Hugging Face access in the build sandbox): the service uses only the documented API
  (`from_pretrained`, `synthesize(..., output=)`, `synthesize_long`, `list_speakers`). Check `docker logs` on first run.
- Voice cloning is supported by the model but not wired in here; the model card requires consent from the person whose voice is cloned.
