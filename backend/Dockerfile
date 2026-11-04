# Build context is the CongLive project root (see server/docker-compose.yml).
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --chown=node:node backend/src ./src
COPY --chown=node:node backend/plugins ./plugins
COPY --chown=node:node webui/admin.html ./public/admin.html
RUN mkdir -p /app/data /app/covers && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
