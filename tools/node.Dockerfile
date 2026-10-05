FROM node:22-alpine
RUN apk add --no-cache bash git curl \
 && corepack enable && corepack prepare pnpm@9.15.0 --activate
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CHOKIDAR_USEPOLLING=1
WORKDIR /repo
