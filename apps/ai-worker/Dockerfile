FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/ai-worker/package.json apps/ai-worker/package.json
RUN npm ci
COPY apps/ai-worker apps/ai-worker
RUN npm run build -w @robot-face/ai-worker

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pil fonts-noto-cjk ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3002 \
    COVER_FONT_PATH=/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc
COPY --from=build /app/apps/ai-worker/server ./server
COPY --from=build /app/apps/ai-worker/src/domain.ts ./src/domain.ts
COPY --from=build /app/apps/ai-worker/src/transcript.ts ./src/transcript.ts
COPY --from=build /app/apps/ai-worker/src/demo.ts ./src/demo.ts
COPY --from=build /app/apps/ai-worker/scripts/news-cover.py ./scripts/news-cover.py
COPY --from=build /app/apps/ai-worker/package.json ./package.json
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "server/index.ts"]
