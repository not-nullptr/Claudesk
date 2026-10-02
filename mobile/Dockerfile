FROM node:22-alpine

WORKDIR /app

COPY mobile/server.mjs ./server.mjs
COPY mobile/gateway.mjs ./gateway.mjs
COPY mobile/system-prompt.mjs ./system-prompt.mjs
COPY mobile/store.mjs ./store.mjs
COPY mobile/auth.mjs ./auth.mjs
COPY mobile/totp.mjs ./totp.mjs
COPY mobile/engine.mjs ./engine.mjs
COPY mobile/connect.mjs ./connect.mjs
COPY mobile/proto.mjs ./proto.mjs
COPY docs/mobile-spec/Claude-Mobile-Proto-Schema-1.260925.19.json ./schema/Claude-Mobile-Proto-Schema-1.260925.19.json

ENV NODE_ENV=production

USER node

EXPOSE 8081

CMD ["node", "server.mjs"]
