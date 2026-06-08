FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV SESSION_DIR=/data/sessions

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "src/index.js"]
