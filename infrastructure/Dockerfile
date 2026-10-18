FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY fixtures ./fixtures
COPY hackathon ./hackathon
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
ENV COLAG_DATA_DIR=/data
CMD ["pnpm", "exec", "tsx", "apps/service/src/index.ts"]
