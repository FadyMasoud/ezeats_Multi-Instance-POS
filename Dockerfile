# syntax=docker/dockerfile:1
# One Dockerfile, three runtime targets: api, fake-pos, admin (nginx + built UI).

FROM node:20-alpine AS deps
WORKDIR /repo
# Git hooks are a developer-machine concern; skip husky inside images.
ENV HUSKY=0
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/fake-pos/package.json apps/fake-pos/
COPY apps/admin/package.json apps/admin/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps ./apps
RUN npm run build -w apps/api -w apps/fake-pos -w apps/admin

FROM node:20-alpine AS prod-deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/fake-pos/package.json apps/fake-pos/
COPY apps/admin/package.json apps/admin/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:20-alpine AS api
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY apps/api/package.json apps/api/
COPY apps/api/drizzle apps/api/drizzle
COPY --from=build /repo/apps/api/dist apps/api/dist
WORKDIR /repo/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM node:20-alpine AS fake-pos
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY apps/fake-pos/package.json apps/fake-pos/
COPY --from=build /repo/apps/fake-pos/dist apps/fake-pos/dist
WORKDIR /repo/apps/fake-pos
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

# 1.28 (stable) supports `resolve` on upstream servers, used in docker/nginx.conf.
FROM nginx:1.28-alpine AS admin
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
