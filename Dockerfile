FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --ignore-scripts && npm --prefix server ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
RUN npm --prefix server run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --ignore-scripts && npm --prefix server ci --omit=dev --ignore-scripts
COPY --from=build --chown=node:node /app/server/dist ./server/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/server/index.js"]
