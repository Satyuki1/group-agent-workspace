FROM node:24-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /source/team
COPY team/package*.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"
COPY team/index.html team/tsconfig.json team/vite.config.mjs ./
COPY team/web web
COPY team/shared shared
COPY app/package.json /source/app/package.json
COPY app/ui/src /source/app/ui/src
COPY ds-bot/package.json /source/ds-bot/package.json
COPY ds-bot/src/client /source/ds-bot/src/client
COPY ds-bot/src/shared /source/ds-bot/src/shared
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS app
WORKDIR /app
COPY --from=build /source/team/node_modules node_modules
COPY --from=build /source/team/dist dist
COPY team/package.json .
COPY team/server server
COPY team/shared shared
COPY team/migrations migrations
RUN mkdir -p /data/files && chown -R node:node /data
USER node
ENV IM_HOST=0.0.0.0 IM_STORAGE=/data/files
CMD ["node","server/main.ts"]
