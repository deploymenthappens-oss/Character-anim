# VoiceTut TTS service. Needs a GPU host for real-time speech (model card: ~1.1x real time on a T4, 2.9 GB VRAM).
# Build:  docker build -t voicetut ./voicetut
# Run:    docker run --gpus all -p 8000:8000 -e VOICETUT_TOKEN=secret voicetut
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
# OmniVoice is not on PyPI (model card): install it from GitHub first, then the wrapper
RUN pip install --no-cache-dir git+https://github.com/k2-fsa/OmniVoice.git \
 && pip install --no-cache-dir -r requirements.txt
COPY app.py .
ENV HF_HOME=/models
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
