FROM node:22-alpine

WORKDIR /app

# 安装 better-sqlite3 的编译依赖
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --production && \
    # 编译完成后清理编译工具，减小镜像体积
    apk del python3 make g++ && \
    rm -rf /root/.npm /tmp/*

COPY src/ ./src/

# 数据目录（挂载 volume）
RUN mkdir -p /app/data

EXPOSE 3050

ENV PORT=3050 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/command-go.db \
    NODE_ENV=production

CMD ["node", "src/server.js"]
