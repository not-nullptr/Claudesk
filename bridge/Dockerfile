FROM node:22-alpine

WORKDIR /app

# Wildcard on purpose: the bridge's runtime modules are every top-level .mjs in
# bridge/ (the shared build context has no other .mjs there), and an explicit
# line-per-module list silently rots — a module added without its own COPY line
# builds fine and only the running container fails with ERR_MODULE_NOT_FOUND,
# which is exactly how bridge/notifications.mjs once shipped uncopied.
# scripts/docker-copy-smoke.mjs pins that this wildcard covers the entry's whole
# local reference graph, so a future subdirectory or a re-explicitized list
# cannot regress it quietly.
COPY bridge/*.mjs ./
COPY bridge/public ./public
COPY config/release.json ./release.json

ENV NODE_ENV=production

USER node

EXPOSE 8080

CMD ["node", "server.mjs"]
