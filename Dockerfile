FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm install --production
COPY server/ ./
COPY public/ ./public/
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "index.js"]
