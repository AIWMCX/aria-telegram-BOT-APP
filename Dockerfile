FROM node:22-slim
# node:sqlite (used instead of better-sqlite3) needs the flag dropped in
# 22.13.0 (existed but required --experimental-sqlite from 22.5–22.12) — do
# not pin this to an exact patch below 22.13, and don't downgrade below 22
# at all without reverting src/db.ts to a native driver.

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data
ENV DB_PATH=/data/aria.db
ENV NODE_ENV=production

EXPOSE 8080
CMD ["npm", "start"]
