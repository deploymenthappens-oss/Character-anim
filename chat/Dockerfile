FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends espeak-ng ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js llm.js edge.js .
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
