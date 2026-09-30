# 零依赖，所以不需要 npm install，镜像可以非常小。
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

# 监听所有网卡，让容器外可访问。
# DISABLE_DISK_CACHE=1：容器文件系统通常是临时的，缓存没必要落盘。
ENV HOST=0.0.0.0 \
    PORT=8080 \
    DISABLE_DISK_CACHE=1 \
    NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "server/index.js"]
