FROM node:24-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /opt/agent
RUN npm init -y && npm install --registry="$NPM_REGISTRY" --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.1 @deepseek-ai/dsh-app-boot@0.2.2-rc.1 @deepseek-ai/dsh-tools@0.2.2-rc.1
COPY worker.mjs worker.patch.yml ./
RUN mkdir -p /state && chown node:node /state
USER node
ENV DSH_HOME=/state/dsh DSH_TELEMETRY_DISABLED=1
ENTRYPOINT ["node","/opt/agent/worker.mjs"]
