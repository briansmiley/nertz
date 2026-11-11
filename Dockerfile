# Proposed production image (see README "Hosting plan"). Not deployed anywhere.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared shared
COPY server server
COPY --from=build /app/dist dist
USER node
EXPOSE 8080
# One process: serves dist/ and the websocket. tsx runs the TypeScript directly.
CMD ["node_modules/.bin/tsx", "server/index.ts"]
