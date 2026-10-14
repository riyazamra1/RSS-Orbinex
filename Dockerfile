FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm install --workspace @rss-orbinex/api

COPY . .
RUN npm run build

ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "start", "--workspace", "@rss-orbinex/api"]
