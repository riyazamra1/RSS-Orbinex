FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm install --include=dev --workspace @rss-orbinex/api

COPY . .
RUN npm run build
RUN npm prune --omit=dev --workspace @rss-orbinex/api

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "start", "--workspace", "@rss-orbinex/api"]
