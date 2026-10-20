# --ignore-scripts is required, not just hardening.
#
# better-sqlite3 v13 ships N-API prebuilds (including linuxmusl-x64/arm64) and sets
# "gypfile": false to tell npm not to build it. npm still sees binding.gyp and runs
# `node-gyp rebuild` anyway under `npm ci`, which fails on alpine — no Python, no
# toolchain — even though the correct prebuild is sitting right there in the tarball.
# Skipping install scripts lets the prebuild be used, and every native package in the
# production tree resolves its binary at require time, so nothing is lost.

FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production dependencies only — the runtime image must not ship devDependencies
# (drizzle-kit/vitest/eslint and their transitive advisories).
FROM node:24-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
# pg is only the test client. drizzle-orm and bullmq declare it as an optional
# peer, so this install still places it in node_modules. The server does not
# open Postgres from this image.
RUN npm ci --omit=dev --ignore-scripts \
 && rm -rf \
      node_modules/pg \
      node_modules/pg-connection-string \
      node_modules/pg-int8 \
      node_modules/pg-pool \
      node_modules/pg-protocol \
      node_modules/pg-types \
      node_modules/pgpass \
      node_modules/postgres-array \
      node_modules/postgres-bytea \
      node_modules/postgres-date \
      node_modules/postgres-interval

FROM node:24-alpine AS runtime

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN apk add --no-cache ffmpeg \
    && mkdir -p /app/data/sessions /app/data/media /app/data/media-downloads

# Fail the build instead of the container if the native prebuild did not resolve.
RUN node -e "const D=require('better-sqlite3'); new D(':memory:').exec('create table t(a)'); console.log('better-sqlite3 OK')"

EXPOSE 3000

CMD ["node", "dist/index.js"]
