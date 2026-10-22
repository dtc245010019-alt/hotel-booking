# syntax=docker/dockerfile:1
FROM node:22.23.4-alpine3.23

ENV NODE_ENV=production \
    TZ=Asia/Ho_Chi_Minh \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# Cài dependency theo đúng package-lock (tận dụng cache layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Mã nguồn thuộc root, chỉ đọc với user node -> tiến trình không sửa được code của chính nó
COPY server.js ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
