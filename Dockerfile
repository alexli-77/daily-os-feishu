# syntax=docker/dockerfile:1
#
# daily-os-feishu — Docker / Linux runtime shape.
#
# IMPORTANT: containers have no `claude` / `codex` subscription CLI. The Docker
# shape MUST use an API-key provider (llm.provider = anthropic | openai) with the
# matching API key supplied via .env. See docs/deploy-docker.md.

# ---- build stage: install full deps and compile TypeScript -> dist ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: prod deps only + compiled output ------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    DAILY_OS_SCHEDULER=loop \
    DAILY_OS_IN_CONTAINER=1 \
    DAILY_OS_UI_HOST=0.0.0.0
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY prompts ./prompts
COPY config/config.example.yaml ./config/config.example.yaml
COPY .env.example ./.env.example

# Non-root user; data + memory-vault are mounted volumes owned by that user.
RUN useradd --create-home --uid 10001 dailyos \
    && mkdir -p /app/data /app/memory-vault \
    && chown -R dailyos:dailyos /app
USER dailyos

VOLUME ["/app/data", "/app/memory-vault"]
EXPOSE 14573

ENTRYPOINT ["node", "dist/index.js"]
CMD ["start", "--no-open", "--host", "0.0.0.0"]
