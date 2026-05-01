FROM node:20-slim

# Install chromium dependencies for Playwright
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Default: run bughunter ci
ENTRYPOINT ["npx", "bughunter"]
CMD ["ci", "--fail-on", "major+"]
