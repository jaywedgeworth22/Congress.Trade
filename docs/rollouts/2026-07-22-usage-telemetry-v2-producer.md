# Congress.Trade usage telemetry v2 producer

## Contract

- Receiver prerequisite: Usage-Monitor exact main `335723775ef0f8114ee1ca77b4716139018026dc`, committed live on Oracle.
- Shared source: immutable `v2.0.0`, commit `19a077a4a8245963775c9fedb462a6741b0a70aa`; provenance is recorded beside the vendor tree.
- Runtime: Deno imports the vendored source and resolves Zod v4.4.3.
- Fresh events: strict v2 only, with required `eventId` and batch-level `producerId: "congress-trade"`.
- Attribution: event identity is not reused as an API-key reference. `producerKeyRef` remains absent when the producer does not know a real stable credential reference.

## Backlog safety

New Queue and R2 outbox rows store strict v2 events. Pre-existing v1 Queue/R2/D1 rows are parsed at the drain boundary and sent only through shared v2.0.0's `sendLegacyOutbox`, which promotes the durable `idempotencyKey` to `eventId` and checks `sourceApp` against the configured producer. No path writes both versions.

## Verification

- Exact vendor source/manifests comparison against tag `v2.0.0`: pass.
- `deno check src/deno/main.ts`: pass.
- Focused v2 producer/legacy drain/operator tests: 3 files / 73 tests pass.
- Full app suite: 156 files / 1,774 tests pass.
- PR #752 merged as `c800550` after hosted CI/PWA/security and the Deno preview build passed.
- The first main deploy failed before build because preceding Dependabot #747 selected AWS SDK
  `3.1092.0`, still inside Deno's 24-hour minimum-age gate. Follow-up branch
  `codex/deno-aws-min-age-hotfix` exact-pins aged `3.1091.0` across npm/Deno manifests without
  weakening the gate; `deno install --reload` and root/app Deno checks pass.
- Corrected main deployment, exact live revision, and receiver ACK: pending.
