# Railway deploy: one service, no MediaMTX, no nginx, no UDP.
# Build context is the repo root (this file), unlike chat/Dockerfile (context ./chat, used by
# docker-compose.yml for the camera+WHIP hybrid setup). Railway auto-detects this file at the root.
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends espeak-ng ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY chat/package.json chat/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY chat/server.js chat/llm.js chat/edge.js ./
COPY web /web
ENV PORT=3000
ENV STATIC_ROOT=/web
EXPOSE 3000
USER node
CMD ["node", "server.js"]
