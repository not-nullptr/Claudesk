# syntax=docker/dockerfile:1
#
# Build context is the repository root (see compose.yaml), because this image
# needs both auth/ (the service) and web/ (the SPA it serves).

# ── The SPA, built with Bun ─────────────────────────────────────────────────
FROM oven/bun:1 AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# ── The service ─────────────────────────────────────────────────────────────
FROM rust:1-bookworm AS build
# libsqlite3-dev lets sqlx's sqlite build link (or bundle) SQLite; pkg-config is
# how it is found. Kept here so the runtime can stay slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Compile the dependency graph once against a stub, so a source edit does not
# rebuild the world.
COPY auth/Cargo.toml auth/Cargo.lock ./
RUN mkdir -p src && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY auth/migrations ./migrations
COPY auth/src ./src
# COPY preserves the sources' (older) mtimes, so without this touch Cargo sees
# the stub build above as up to date and ships the stub — a binary with an empty
# main that exits 0 immediately. Touch forces the real rebuild.
RUN find src -type f -exec touch {} + && cargo build --release --locked

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/release/authd /app/authd
COPY --from=web /web/dist /app/web
ENV AXTD_BIND=0.0.0.0:8080 \
    AXTD_DB=/data/auth.db \
    AXTD_WEB_DIR=/app/web
EXPOSE 8080
USER 1000:1000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/app/authd", "--healthcheck"]
CMD ["/app/authd"]
