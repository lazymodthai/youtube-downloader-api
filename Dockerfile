FROM python:3.11-slim

# ติดตั้ง Node.js และ dependencies พื้นฐาน
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ติดตั้ง Python packages
RUN pip install --no-cache-dir yt-dlp openai-whisper

# Auto-update yt-dlp เมื่อ container เริ่มทำงาน
RUN echo '#!/bin/bash' > /app-entrypoint.sh \
  && echo 'pip install --no-cache-dir --upgrade yt-dlp 2>/dev/null || true' >> /app-entrypoint.sh \
  && echo 'exec "$@"' >> /app-entrypoint.sh \
  && chmod +x /app-entrypoint.sh

ENTRYPOINT ["/app-entrypoint.sh"]

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 4000
CMD ["node", "server.js"]
