FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY src/ src/
COPY tsconfig.json ./

RUN mkdir -p transcripts

EXPOSE 8080

CMD ["npx", "tsx", "src/server.ts"]
