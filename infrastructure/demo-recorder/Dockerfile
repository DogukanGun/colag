# Colag demo recorder: headless Chromium (Playwright) + ffmpeg. Build: pnpm demo:image
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/recorder
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY timeline.mjs render.mjs music.mjs ./
RUN node music.mjs /opt/recorder/bed.wav
ENV HOME=/tmp NODE_ENV=production
ENTRYPOINT ["node", "/opt/recorder/render.mjs"]
