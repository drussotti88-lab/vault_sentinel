# Persistent worker (engine + bot). PRD §21: long-running process, not cron.
FROM node:20-slim

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
# The worker runs forever and self-restarts via the platform on crash.
CMD ["node", "dist/index.js"]
