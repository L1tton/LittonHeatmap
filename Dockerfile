FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY serve.mjs ./
COPY scripts ./scripts
COPY web ./web

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5173

EXPOSE 5173

CMD ["node", "serve.mjs"]
