# syntax=docker/dockerfile:1

# --- builder: compile TypeScript with a standalone tsc (no workspace deps needed) ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-save --no-package-lock typescript@~5.6.3
COPY src ./src
RUN npx tsc -p tsconfig.json

# --- runtime: zero npm dependencies, pure node:http ---
FROM node:22-alpine
RUN addgroup -S mercury && adduser -S mercury -G mercury
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY data ./data
USER mercury
ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
