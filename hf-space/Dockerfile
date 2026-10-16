# VoiceTut (Egyptian Arabic TTS) as a Hugging Face Docker Space. Listens on 7860 (the Space's app_port).
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user
WORKDIR /home/user/app
COPY --chown=user requirements.txt .
# OmniVoice is not on PyPI (see the model card): install it from GitHub first, then the wrapper
RUN pip install --no-cache-dir git+https://github.com/k2-fsa/OmniVoice.git \
 && pip install --no-cache-dir -r requirements.txt
COPY --chown=user app.py .
USER user
ENV HF_HOME=/home/user/.cache/huggingface PORT=7860
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
