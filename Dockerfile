FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# Remotion Chromium dependencies + FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg chromium \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2 libpangocairo-1.0-0 libcairo2 libpango-1.0-0 \
    libgtk-3-0 libdrm2 libxshmfence1 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

CMD ["npm", "start"]
