FROM node:22-slim
# node:sqlite (used instead of better-sqlite3) requires Node >=22.5 — do not
# downgrade this base image without also reverting src/db.ts to a native driver.

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
