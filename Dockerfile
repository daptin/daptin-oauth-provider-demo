FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY scripts ./scripts
COPY README.md ./

ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0

EXPOSE 7777

CMD ["node", "server.js"]
