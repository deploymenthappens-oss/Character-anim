# Optional: the most natural Egyptian voice (VoiceTut on a Hugging Face Space)

**You do not need this to run the project.** With nothing set, the avatar already speaks with Microsoft's Egyptian neural voices
(`ar-EG-ShakirNeural`, male, with `ar-EG-SalmaNeural` as the backup) and the mouth follows the engine's own word timings.
VoiceTut is a more natural, human-sounding Egyptian voice (17 speakers, reads English words too). It needs a GPU, which Railway does not have.

## Steps
1. huggingface.co -> **New Space** -> SDK **Docker** (Blank) -> hardware **Nvidia T4 small** (paid, billed per hour while running; the model card measured ~1.1x real time on a T4. A free CPU Space starts, but is much too slow for a live chat) -> visibility **Private**.
2. Upload the four files from the `hf-space/` folder (README.md, Dockerfile, app.py, requirements.txt). The first build takes several minutes and the first start downloads the model.
3. Settings -> **Variables and secrets**: nothing is required (a private Space is protected by your Hugging Face token). Optional: set the Space variable `VOICETUT_SPEAKER`.
4. Create a token: huggingface.co/settings/tokens -> **Read** -> copy it (`hf_...`).
5. Open `chat/config.js` in this project and fill in the two lines, then redeploy Railway:

       HF_TOKEN: 'hf_xxxxxxxxxxxxxxxx',
       VOICETUT_URL: 'https://YOUR-NAME-YOUR-SPACE.hf.space',

   (The Space's "Embed this Space" menu shows the exact `.hf.space` address.)
6. Open `https://YOUR-RAILWAY-URL/voices`: it should show `"engine":"voicetut"` and `"up":true`. If `up` is false it shows the last error;
   until it is up, every line is spoken by the Egyptian Edge voice, so the stream never goes silent.

The same `HF_TOKEN` also switches on Hugging Face's free OpenAI-compatible router as the first reply model (`HF_LLM_MODEL` in `config.js`),
with the free keyless gateways as the fallback.

Not tested against the real model by the author (no GPU or Hugging Face access in the build sandbox): the service only uses the model card's documented API. Check the Space logs on first start (`[voicetut] warm`).
