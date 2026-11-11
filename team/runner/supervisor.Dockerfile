FROM docker:29-cli AS cli
FROM node:24-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY"
COPY runner/main.ts runner/classify.ts runner/
COPY shared shared
CMD ["node","runner/main.ts"]
