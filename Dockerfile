# Railway deploy: ONE service = web + chat server + the built-in Egyptian TTS pipeline (CPU, ./tts) with its admin dashboard at /admin.
# The voice runs inside this container on 127.0.0.1:8000 and the chat server finds it by itself (EGY_LOCAL=1, set by start.sh).
#   - To use an external voice service instead: set VOICETUT_URL (it wins over the built-in one).
# Built-in voice backends; ONE runs, chosen at runtime by the TTS_BACKEND variable (see start.sh):
#   egy (default) = ./tts, the Egyptian TTS pipeline (VoiceTut + Edge + espeak fallbacks, cache, admin dashboard at /admin)
#   cairo         = ./cairo, the Cairo-TTS service (clones your voice from chat/voice/my-voice.wav)
#   Build args (Railway: service variables of the same name):
#     WITH_EGY=1 (default)   include the Egyptian TTS pipeline
#     WITH_CAIRO=0 (default) 1 adds the old Cairo-TTS backend (a second PyTorch, ~1 GB more: only if your plan allows a big image)
#     BAKE_MODEL=0 (default) 1 downloads the VoiceTut weights INTO the image (faster first start, much bigger image). 0 = fetched on first start.
FROM node:22-slim
ARG WITH_CAIRO=0
ARG WITH_EGY=1
ARG BAKE_MODEL=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends espeak-ng ca-certificates \
 && if [ "$WITH_CAIRO" = "1" ] || [ "$WITH_EGY" = "1" ]; then apt-get install -y --no-install-recommends python3 python3-venv python3-pip libsndfile1; fi \
 && if [ "$WITH_EGY" = "1" ]; then apt-get install -y --no-install-recommends ffmpeg; fi \
 && rm -rf /var/lib/apt/lists/*

# ---- Egyptian TTS pipeline (CPU) in its own virtualenv (/opt/venv-egy); the weights are fetched at build time into the shared HF cache ----
ENV HF_HOME=/opt/hf-cache
COPY tts/requirements.txt tts/requirements-model.txt /opt/egy-tts/
RUN if [ "$WITH_EGY" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends git build-essential \
      && python3 -m venv /opt/venv-egy \
      && /opt/venv-egy/bin/pip install --no-cache-dir --upgrade pip \
      && /opt/venv-egy/bin/pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
      && /opt/venv-egy/bin/pip install --no-cache-dir git+https://github.com/k2-fsa/OmniVoice.git \
      && /opt/venv-egy/bin/pip install --no-cache-dir -r /opt/egy-tts/requirements.txt -r /opt/egy-tts/requirements-model.txt \
      && ( /opt/venv-egy/bin/pip list 2>/dev/null | grep -i -E "^(torch|torchaudio|nvidia|triton)" ; du -sh /opt/venv-egy ) \
      && apt-get purge -y git build-essential && apt-get autoremove -y --purge && rm -rf /var/lib/apt/lists/* /root/.cache \
      && if [ "$BAKE_MODEL" = "1" ]; then \
           (/opt/venv-egy/bin/python -c "from voicetut_tts import VoiceTutTTS; VoiceTutTTS.from_pretrained('mohammedaly22/VoiceTut-TTS')" || echo "VoiceTut pre-download failed: it will be fetched at first start") ; \
         else echo "BAKE_MODEL=0: VoiceTut weights are downloaded at first start (smaller image)"; fi ; \
    fi \
 && mkdir -p /opt/hf-cache && chown -R node:node /opt/hf-cache
COPY tts/egy_tts /opt/egy-tts/egy_tts

# ---- Cairo-TTS (CPU) in its own virtualenv; the model is downloaded at build time so the first start is fast ----
ENV PATH=/opt/venv/bin:$PATH CAIRO_TTS_DEVICE=cpu CAIRO_TTS_QUANTIZE=0
COPY cairo/requirements.txt /opt/cairo/requirements.txt
COPY cairo/app.py /opt/cairo/app.py
RUN if [ "$WITH_CAIRO" = "1" ]; then \
      python3 -m venv /opt/venv \
      && pip install --no-cache-dir --upgrade pip \
      && pip install --no-cache-dir typing-extensions filelock sympy networkx jinja2 fsspec setuptools \
      && pip install --no-cache-dir --no-deps torch --index-url https://download.pytorch.org/whl/cpu \
      && pip install --no-cache-dir -r /opt/cairo/requirements.txt \
      && (python -c "from cairo_tts import CairoTTS; CairoTTS.from_pretrained()" || echo "model pre-download failed: it will be fetched at first start") ; \
    fi \
 && mkdir -p /opt/hf-cache && chown -R node:node /opt/hf-cache

WORKDIR /app
COPY chat/package.json chat/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY chat/*.js ./
# the default (cloned) voice; owned by `node` so a voice recorded later in publish.html can be saved over it
COPY --chown=node:node chat/voice ./voice
COPY web /web
COPY start.sh /app/start.sh
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh   # strip Windows CRLF if it slipped in
ENV PORT=3000 STATIC_ROOT=/web CAIRO_LOCAL=$WITH_CAIRO
EXPOSE 3000
USER node
CMD ["/app/start.sh"]
