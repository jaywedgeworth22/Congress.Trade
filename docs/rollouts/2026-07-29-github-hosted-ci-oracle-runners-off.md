# 2026-07-29 — GitHub-hosted CI; Oracle Actions runners off

Owner: retire self-hosted Oracle Actions runners; all workflows use `ubuntu-latest`.

- `ci.yml` / `security.yml` → `ubuntu-latest`
- `deploy-oracle.yml` → SSH deploy from hosted runner (`ORACLE_SSH_PRIVATE_KEY` required)
- `check-actions-runner-policy.mjs` allows only `ubuntu-latest`
