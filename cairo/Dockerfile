# Cairo-TTS service (CPU). Works as a Hugging Face Docker Space (port 7860), on Railway, or anywhere with Docker.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH HF_HOME=/home/user/.cache/huggingface PYTHONUNBUFFERED=1 \
    CAIRO_TTS_DEVICE=cpu CAIRO_TTS_QUANTIZE=0 CAIRO_NUM_THREADS=0
WORKDIR /home/user/app
# deps from PyPI first, torch alone from the CPU index: that index serves typing-extensions with a mismatched metadata name, which newer pip rejects
RUN pip install --no-cache-dir --user typing-extensions filelock sympy networkx jinja2 fsspec setuptools \
 && pip install --no-cache-dir --user --no-deps torch --index-url https://download.pytorch.org/whl/cpu
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt
COPY --chown=user app.py .
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1", "--timeout-keep-alive", "75"]
