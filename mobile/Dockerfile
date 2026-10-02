FROM node:22-alpine

WORKDIR /app

COPY mobile/server.mjs ./server.mjs
COPY mobile/desktop-client.mjs ./desktop-client.mjs
COPY mobile/transcript.mjs ./transcript.mjs
COPY mobile/events.mjs ./events.mjs
COPY mobile/blocks.mjs ./blocks.mjs
COPY mobile/capture.mjs ./capture.mjs
COPY mobile/store.mjs ./store.mjs
COPY mobile/auth.mjs ./auth.mjs
COPY mobile/totp.mjs ./totp.mjs
COPY mobile/engine.mjs ./engine.mjs
COPY mobile/connect.mjs ./connect.mjs
COPY mobile/proto.mjs ./proto.mjs
# The Code (Claude Code) surface. These are imported by server.mjs and
# code-engine.mjs, so an image built without them cannot boot at all — the
# container exits with ERR_MODULE_NOT_FOUND before it serves a request.
COPY mobile/code-ids.mjs ./code-ids.mjs
COPY mobile/code-transcript.mjs ./code-transcript.mjs
COPY mobile/code-events.mjs ./code-events.mjs
COPY mobile/code-engine.mjs ./code-engine.mjs
COPY docs/mobile-spec/Claude-Mobile-Proto-Schema-1.260925.19.json ./schema/Claude-Mobile-Proto-Schema-1.260925.19.json

ENV NODE_ENV=production

USER node

EXPOSE 8081

CMD ["node", "server.mjs"]
