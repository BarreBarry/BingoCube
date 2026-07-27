# Cube Bingo server — portable container image.
# Runs on Fly.io, Railway, Render, Google Cloud Run, a VPS — anywhere containers run.
FROM node:20-slim

WORKDIR /app

# Build tools so better-sqlite3 compiles reliably if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better Docker layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source (server.js + public/).
COPY . .

# The database file. /data is meant to be a mounted persistent volume in
# production (see fly.toml / render.yaml). Without a volume it still works,
# but the data is ephemeral (resets when the container is recreated).
RUN mkdir -p /data
ENV DB_FILE=/data/game.db
ENV NODE_ENV=production

# Set the host password at deploy time — never bake secrets into the image:
#   Fly:      fly secrets set HOST_PASSWORD=...
#   Render:   set HOST_PASSWORD in the dashboard
#   docker:   docker run -e HOST_PASSWORD=... ...
EXPOSE 3000
CMD ["node", "server.js"]
