# Host-agnostic image for the clinic/tailor voice agent + dashboard.
# Works on Render, Railway, Fly.io, a VPS, or any container host that
# supports long-lived WebSocket connections (required for Twilio Media Streams).
FROM node:20-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# The server reads PORT from the environment (hosts inject their own).
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
