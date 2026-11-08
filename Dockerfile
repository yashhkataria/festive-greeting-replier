# Runs the agent with the system Chromium, so it works on any cloud host that
# runs containers. Keep /app/.data on a persistent volume: it holds your
# WhatsApp login, scheduled replies and history.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    RUNNING_IN_CONTAINER=1 \
    DATA_DIR=/app/.data

WORKDIR /app
COPY package.json package-lock.json .puppeteerrc.cjs ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts

# Runs as root so it can write to cloud volumes, which are usually root-owned.
CMD ["node", "src/index.js"]
