FROM denoland/deno:alpine

WORKDIR /app

# Cache dependencies
COPY package.json ./
RUN deno install || true

# Copy source
COPY . .

# Cache source files
RUN deno cache src/deno/main.ts

ENV PORT=5000
EXPOSE 5000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-sys", "--allow-ffi", "--unstable-kv", "--unstable-cron", "src/deno/main.ts"]
