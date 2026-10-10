FROM node:22-alpine

WORKDIR /app

# Wildcard on purpose: the facade's runtime modules are every top-level .mjs in
# mobile/. An explicit line-per-module list is only ever one forgotten import
# away from an image that builds but cannot boot (the Code surface modules were
# added to this list for exactly that reason); scripts/docker-copy-smoke.mjs
# pins that the wildcard covers the entry's whole local reference graph.
COPY mobile/*.mjs ./
COPY docs/mobile-spec/Claude-Mobile-Proto-Schema-1.260925.19.json ./schema/Claude-Mobile-Proto-Schema-1.260925.19.json

ENV NODE_ENV=production

USER node

EXPOSE 8081

CMD ["node", "server.mjs"]
