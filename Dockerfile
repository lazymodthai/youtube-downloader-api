FROM node:20-alpine

# เปิด repo edge เพื่อให้มี ffmpeg
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories \
  && echo "https://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories \
  && apk update \
  && apk add --no-cache python3 py3-pip ffmpeg curl bash \
  && pip install --no-cache-dir --break-system-packages --upgrade yt-dlp

# Auto-update yt-dlp เมื่อ container เริ่มทำงาน
RUN echo '#!/bin/sh' > /app-entrypoint.sh \
  && echo 'pip install --no-cache-dir --break-system-packages --upgrade yt-dlp 2>/dev/null || true' >> /app-entrypoint.sh \
  && echo 'exec "$@"' >> /app-entrypoint.sh \
  && chmod +x /app-entrypoint.sh

ENTRYPOINT ["/app-entrypoint.sh"]

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 4000
CMD ["node", "server.js"]
