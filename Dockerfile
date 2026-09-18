# --ignore-scripts is required, not just hardening.
#
# better-sqlite3 v13 ships N-API prebuilds (including linuxmusl-x64/arm64) and sets
# "gypfile": false to tell npm not to build it. npm still sees binding.gyp and runs
# `node-gyp rebuild` anyway under `npm ci`, which fails on alpine — no Python, no
# toolchain — even though the correct prebuild is sitting right there in the tarball.
# Skipping install scripts lets the prebuild be used, and every native package in the
# production tree resolves its binary at require time, so nothing is lost.

FROM node:25-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production dependencies only — the runtime image must not ship devDependencies
# (drizzle-kit/vitest/eslint and their transitive advisories).
FROM node:25-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:25-alpine AS runtime

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/data/sessions /app/data/media

# Fail the build instead of the container if the native prebuild did not resolve.
RUN node -e "const D=require('better-sqlite3'); new D(':memory:').exec('create table t(a)'); console.log('better-sqlite3 OK')"

EXPOSE 3000

CMD ["node", "dist/index.js"]
