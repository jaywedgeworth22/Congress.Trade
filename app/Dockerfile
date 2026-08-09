FROM denoland/deno:alpine

WORKDIR /app

# curl is used by Coolify's container health_check_command and by ops probes.
# deno:alpine only ships wget by default — without curl Coolify can mark the
# stack exited:unhealthy and take congress.trade to 502 while Deno is fine.
RUN apk add --no-cache curl

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

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-sys", "--allow-ffi", "--unstable-kv", "--unstable-cron", "src/deno/main.ts"]
