# ara

pnpm monorepo.

## Layout

- `apps/*` — deployable applications
  - `apps/api` — Effect TS HTTP API (hexagonal architecture)
- `packages/*` — shared libraries

## Getting started

```sh
pnpm install
cp .env.example .env      # Postgres credentials, read by both Compose and the API
docker compose up -d      # Postgres on ${DATABASE_PORT:-5432}
pnpm --filter @ara/api dev
```

The API applies any outstanding schema migrations on boot and refuses to start
if it cannot, so `docker compose up` and `pnpm dev` are the whole setup.
`GET /health` reports the database as a dependency: stop the container and it
goes `503`, start it again and it recovers.

The same process runs the HTTP API and the background worker that claims queued
Runs, so the MVP is one thing to deploy. Set `WORKER_ENABLED=false` to run an
instance that only serves HTTP.

A Run reads the day's Activity from GitHub, builds a Digest of what actually
happened — commit subjects, file paths and line counts, never diffs — and stores
it. `GET /v1/runs/:id/digest` is what that Run decided.

It then writes a Draft from that Digest alone, and nothing else: no source code
is ever sent to a language model (`docs/adr/0004-no-diffs-in-the-digest.md`).
`GET /v1/runs/:id/draft` is the post, in markdown, with the model that wrote it
and what it cost attached. Set `OPENROUTER_API_KEY` before asking for a Run;
`DRAFT_MODEL` decides which model answers, and neither the use cases nor the
tests know or care which one it is.

Scripts at the root fan out to every workspace package: `pnpm build`, `pnpm dev`,
`pnpm test`, `pnpm lint`, `pnpm typecheck`.

`pnpm test` never touches the network. The contract tests, which read a real
repository from GitHub to catch it changing the shape of a reply, are excluded
from it and from CI; run them by hand with
`pnpm --filter @ara/api test:contract` once the `CONTRACT_GITHUB_*` variables in
`.env` point at a scratch repository.

## Adding a package

```sh
mkdir -p packages/my-lib && cd packages/my-lib && pnpm init
```

Then depend on it from another workspace with `pnpm add my-lib --workspace --filter my-app`.
