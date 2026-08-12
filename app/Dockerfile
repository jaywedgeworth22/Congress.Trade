FROM denoland/deno:alpine

WORKDIR /app

# curl is used by Coolify's container health_check_command and by ops probes.
# deno:alpine only ships wget by default — without curl Coolify can mark the
# stack exited:unhealthy and take congress.trade to 502 while Deno is fine.
# bash/tar/ca-certificates are for scripts/start-with-litestream.sh (Litestream
# continuous B2 backup, rebuilt 2026-08-12 after the Oracle->Hetzner migration
# dropped the old host-level systemd unit) and scripts/fetch-litestream.sh.
RUN apk add --no-cache curl bash tar ca-certificates

# Litestream binary (pinned + sha256-verified) for continuous SQLite -> B2
# replication. See scripts/fetch-litestream.sh for the pin rationale (0.5.13,
# not 0.5.14 — Socratic.Trade hit a socket-churn regression in 0.5.14 on this
# same Coolify/Hetzner box). A download/checksum failure here leaves
# ./bin/litestream absent, which is deploy-safe: scripts/start-with-litestream.sh
# only requires the binary when B2 replica credentials actually resolve.
COPY scripts/fetch-litestream.sh scripts/fetch-litestream.sh
RUN bash scripts/fetch-litestream.sh

# Infisical CLI, via Alpine's official apk repo (the generic linux-glibc
# release tarball Socratic.Trade/Usage-Monitor use on Debian does not
# reliably run on Alpine's musl libc — see
# https://github.com/Infisical/infisical/issues/3511). Used only by
# scripts/start-with-litestream.sh to fetch the 5 LITESTREAM_S3_* secrets
# needed to run litestream as an external sibling process; the Deno app's own
# secrets keep resolving in-process via src/secrets/infisical.ts, unaffected.
RUN wget -qO- 'https://artifacts-cli.infisical.com/setup.apk.sh' | sh \
  && apk add --no-cache infisical \
  && infisical --version

# Cache dependencies
COPY package.json ./
RUN deno install || true

# Copy source
COPY . .

# Cache source files
RUN deno cache src/deno/main.ts

# Build revision, so /api/health can report which commit is actually running.
# Coolify supplies SOURCE_COMMIT; any other builder can pass --build-arg.
ARG SOURCE_COMMIT=""
ENV CT_BUILD_SHA=$SOURCE_COMMIT

ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:5000/api/health >/dev/null || exit 1

# scripts/start-with-litestream.sh wraps the same `deno run ...` invocation
# that used to be CMD directly. When B2 replica credentials are not
# configured (e.g. local/preview) it falls straight through to that
# unmodified deno run — no behavior change for those environments.
CMD ["bash", "scripts/start-with-litestream.sh"]
