# Preview deployments

Use this when you want a browser-accessible review site before merging or
deploying `congress.trade`.

The preview deployment is intentionally isolated:

- Worker: `congress-feed-preview`
- Config: `app/wrangler.preview.toml` (generated locally, ignored by git)
- Database: `congress-feed-preview-db`
- R2 bucket: `congress-feed-preview-raw`
- Queues: `congress-feed-preview-*`
- KV namespace: separate preview namespace
- No custom-domain route and no cron trigger by default

## First-time setup

```bash
cd app
npm run preview:provision
```

This creates preview Cloudflare resources, writes `wrangler.preview.toml`, applies
D1 migrations, and seeds a tiny fixture dataset so the public feed, search,
drawers, and Pelosi option rows are visible even before real preview ingestion is
configured.

## Deploy the current checkout

```bash
cd app
npm run preview:deploy
```

The deploy script runs `npm run typecheck`, `npm test`, then:

```bash
npx wrangler deploy --config wrangler.preview.toml
```

Wrangler prints the `workers.dev` URL after a successful deploy. Use that URL to
review branch work. Do not use `npm run deploy`, `npm run deploy:full`, or
`scripts/ship.sh` for preview; those target production.

## Optional custom domain

If you want a stable URL like `preview.congress.trade`, add a route to the
generated `wrangler.preview.toml` only after the preview Worker is working:

```toml
routes = [
  { pattern = "preview.congress.trade", custom_domain = true }
]
workers_dev = true
```

Keep that in the ignored preview config unless the team decides to commit a
first-class staging environment with permanent resource IDs.

## Merge policy

Preview deploys are for review. Merging to `main` still deploys production via
Cloudflare Workers Builds and production migrations are not automatic. Before
merging, run:

```bash
cd app
npm run typecheck
npm test
```

Apply remote migrations only when the production deploy intentionally needs them.
