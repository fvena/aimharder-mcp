# Remote (HTTP) deployment of aimharder-mcp. Settings come from the platform's secrets; members, invitations and
# settings live in MCP_DATA_DIR, a mounted volume.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache su-exec
ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 PORT=8080 MCP_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# A fresh volume is owned by root: hand the data directory to the unprivileged user, then run the server as that user.
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
CMD ["sh", "-c", "chown node:node \"$MCP_DATA_DIR\" && exec su-exec node node dist/index.js"]
