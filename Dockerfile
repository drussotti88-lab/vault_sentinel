# Persistent worker (engine + bot). PRD §21: long-running process, not cron.
# Node 22+ ships a native global WebSocket, which @supabase/supabase-js's
# realtime client requires; on Node 20 it throws at startup ("Node.js 20
# detected without native WebSocket support").
FROM node:22-slim

WORKDIR /app

# Install deps against the lockfile first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build TypeScript -> dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies for a slimmer runtime image.
RUN npm prune --omit=dev

ENV NODE_ENV=production
# The control API listens on $PORT (the platform injects it; defaults to 8080).
EXPOSE 8080
# The worker runs forever and self-restarts via the platform on crash.
CMD ["node", "dist/index.js"]
