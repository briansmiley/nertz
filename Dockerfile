# The production image, deployed to Fly.io by .github/workflows/deploy.yml (see README "Hosting").
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared shared
COPY server server
COPY --from=build /app/dist dist
# (The start below needs setpriv: better the build fails than the boot.)
RUN command -v setpriv
EXPOSE 8080
# One process: serves dist/ and the websocket. tsx runs the TypeScript directly.
# It runs as `node`. A volume (fly.toml, [mounts]) is mounted owned by root, so the container starts as root only to
# hand DATA_DIR to `node`, and drops to it before anything of ours runs.
CMD ["sh", "-c", "mkdir -p \"$DATA_DIR\" && chown node:node \"$DATA_DIR\" && exec setpriv --reuid=node --regid=node --init-groups node_modules/.bin/tsx server/index.ts"]
