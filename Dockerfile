# Ben Zone game server (also serves the game). No npm install needed.
FROM node:22-alpine
WORKDIR /app
COPY index.html ./
COPY src ./src
COPY server ./server
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server/index.js"]
