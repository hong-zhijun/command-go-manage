# ── 构建阶段：编译 better-sqlite3 原生模块 ──
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production

# ── 运行阶段：精简镜像 ──
FROM node:22-alpine

WORKDIR /app

# 从构建阶段复制已编译的 node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

# 数据目录（挂载 volume 持久化）
RUN mkdir -p /app/data

EXPOSE 3050

ENV PORT=3050 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/command-go.db \
    NODE_ENV=production

CMD ["node", "src/server.js"]
