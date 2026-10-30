FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# The SQLite file lives here, on a named volume. Creating it with node's
# ownership in the image means the fresh volume inherits that, so the
# unprivileged process can create and write the database.
RUN mkdir -p /data && chown node:node /data

USER node

CMD ["node", "src/index.js"]
