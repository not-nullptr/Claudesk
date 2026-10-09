FROM node:22-bookworm-slim

# LibreOffice is the same engine Desktop uses to preview Office files (it runs
# soffice in the Cowork VM), so converting here reproduces Desktop's rendering
# rather than approximating it. The fonts are the metric-compatible substitutes
# that keep Word/Excel/PowerPoint pagination close to the originals — Carlito and
# Caladea stand in for Calibri and Cambria, which most documents assume.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-calc libreoffice-impress \
    fonts-liberation fonts-dejavu-core \
    fonts-crosextra-carlito fonts-crosextra-caladea \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY bridge/office/server.mjs ./server.mjs

ENV NODE_ENV=production \
    OFFICE_PREVIEW_HOST=127.0.0.1 \
    OFFICE_PREVIEW_PORT=8090

# soffice writes a user profile into the per-run temp dir; the node user's HOME
# is writable for anything it still reaches for there.
USER node

EXPOSE 8090

CMD ["node", "server.mjs"]
