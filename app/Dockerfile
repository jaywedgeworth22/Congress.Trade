FROM denoland/deno:alpine

WORKDIR /app

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

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-sys", "--allow-ffi", "--unstable-kv", "--unstable-cron", "src/deno/main.ts"]
