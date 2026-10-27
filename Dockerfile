# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS dependencies
WORKDIR /app
COPY package.json bun.lock prisma.config.ts ./
COPY prisma ./prisma
# postinstall runs prisma generate, which writes the client into src/generated.
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
# The client is already compiled into dist, so skip postinstall here.
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM node:26.12.1-alpine3.23@sha256:bc2b334006f15c7167bbeb2f08f28c2df883f7594a0470e04454ebe7560cfe68 AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Apply available OS fixes and remove npm from the runtime attack surface.
# The application starts with node and never installs packages at runtime.
RUN apk upgrade --no-cache \
  && apk add --no-cache git \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
  && mkdir -m 0700 /app/.msagents \
  && chown node:node /app/.msagents

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
# Download the migration engine for this exact OS, so migrate deploy runs at start.
RUN node node_modules/@prisma/engines/scripts/postinstall.js
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# With DATABASE_URL set, apply new migrations first; a failed migration stops the start.
# migrate deploy holds a Postgres lock, so replicas starting together wait their turn.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node_modules/.bin/prisma migrate deploy || exit 1; fi; exec node --enable-source-maps dist/main.js"]
