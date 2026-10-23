# ============================================================
# LabSync Production Dockerfile
# Optimized for Node.js 20, Canvas, Sharp, and TensorFlow.js
# ============================================================

FROM node:20-bookworm-slim AS base

WORKDIR /app

# Install native dependencies required for node-canvas, sharp, and fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    fontconfig \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy entire backend source (including local neural models in models/)
COPY . .

# Set default environment variables
ENV NODE_ENV=production
ENV PORT=5000
ENV ENFORCE_DEVICE_AUTH=false
ENV REQUIRE_DEVICE_AUTH=false

# Expose backend port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5000/api/wake || exit 1

# Start the server
CMD ["node", "server.js"]
