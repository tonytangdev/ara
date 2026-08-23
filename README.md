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

Scripts at the root fan out to every workspace package: `pnpm build`, `pnpm dev`,
`pnpm test`, `pnpm lint`, `pnpm typecheck`.

## Adding a package

```sh
mkdir -p packages/my-lib && cd packages/my-lib && pnpm init
```

Then depend on it from another workspace with `pnpm add my-lib --workspace --filter my-app`.
