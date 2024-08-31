FROM node:16-alpine

RUN mkdir -p /opt/discord-azure-bot
WORKDIR /opt/discord-azure-bot

# Dependencies
COPY package.json package-lock.json ./
RUN npm install --package-lock-only

# Source files
COPY tsconfig.json ./
COPY ./src ./src
RUN npm run build

ENTRYPOINT [ "node", "build/index.js" ]
