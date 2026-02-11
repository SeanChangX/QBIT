# Build context must be the web/ directory (parent of frontend/).
# Use: context: ., dockerfile: frontend/Dockerfile

FROM node:20.18-alpine3.21 AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine3.21
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
