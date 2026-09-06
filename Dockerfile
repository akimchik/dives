# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile; \
  status=$?; \
  if [ "$status" -eq 0 ]; then \
    exit 0; \
  fi; \
  if [ "$status" -eq 134 ] \
    && [ -d node_modules/.pnpm ] \
    && [ -d node_modules/next ] \
    && [ -d node_modules/react ] \
    && [ -d node_modules/typescript ]; then \
    echo "pnpm install completed, ignoring Node/libuv exit 134 seen under linux/amd64 emulation"; \
    exit 0; \
  fi; \
  exit "$status"

FROM golang:1.26-bookworm AS suuntool-builder
ARG SUUNTOOL_VERSION=v0.8.0
RUN GOBIN=/out go install github.com/tajchert/suuntool@${SUUNTOOL_VERSION}

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm test && pnpm build

FROM node:24-bookworm-slim AS runner
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
WORKDIR /app

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=suuntool-builder /out/suuntool /usr/local/bin/suuntool

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
