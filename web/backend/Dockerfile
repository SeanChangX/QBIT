# Build context must be the web/ directory (parent of backend/ and admin/).

# Stage 1: backend TypeScript build
FROM node:24-alpine3.24 AS backend-build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src/ ./src/
RUN npx tsc

# Stage 2: admin UI build (outputs to /backend/static/admin from vite config)
FROM node:24-alpine3.24 AS admin-build
WORKDIR /admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci
COPY admin/ ./
RUN npm run build

# Stage 3: runtime image
FROM node:24-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
# better-sqlite3 requires native compilation on Alpine. Build tools are added
# and removed in one layer so they never ship. npm, npx, corepack and yarn are
# not needed at runtime (CMD runs node directly) and only add attack surface.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && apk del .build-deps \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=backend-build /app/dist/ ./dist/
COPY --from=admin-build /backend/static/admin ./static/admin/
EXPOSE 3001
CMD ["node", "dist/index.js"]
