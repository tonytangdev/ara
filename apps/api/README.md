# @ara/api

Effect TS HTTP API, organised as a hexagon.

## Layout

Module-first: each feature owns its own hexagon.

```
src/
  health/                      the health module
    api.ts                       its HTTP contract (group + DTOs) — the public surface
    index.ts                     its public face: `HealthLive`, fully wired
    domain/                      the core — no HTTP, no Node, no framework
      health-report.ts             model + the rule that decides healthy/degraded
      ports/system-probe.ts        driven (outbound) port
    application/
      check-health.ts              the use case = driving (inbound) port
    infrastructure/              adapters — the only code that knows the outside world
      http/health-handlers.ts      driving adapter
      system/runtime-system-probe.ts   driven adapter (Node `process` + Postgres)
  database/                    shared infrastructure, not a module
    client.ts                    the one connection pool, published as `SqlClient`
    migrator.ts                  applies outstanding migrations as a Layer
    migrations/                  one file per migration, imported in `index.ts`
  http/
    api.ts                     composes each module's group into one HttpApi
    docs.ts                    serves that HttpApi as Scalar reference docs
    server.ts                  composes each module's layers, then listens
  config.ts
  main.ts                      composition root
```

Dependencies point inwards: `infrastructure → application → domain`. Adapters are
swapped by providing a different `Layer` — the use case test does exactly that
with a stub `SystemProbe`.

Nothing outside a module should import deeper than its `api.ts` or `index.ts`.
Adding a feature means adding one folder plus two lines in `http/`.

## Database

Postgres, via `@effect/sql-pg`, raw SQL, no ORM. `DatabaseLive` is provided once
in `main.ts`, so the whole application shares one pool and no call site builds
its own. Because migrations are a `Layer`, they run while the application is
being built — before the server binds — and a migration that cannot be applied
fails the launch loudly rather than showing up as a query error later.

Adding a migration: drop `NNNN_name.ts` in `database/migrations/` with a default
export of an `Effect` that needs `SqlClient`, then add it to the record in
`database/migrations/index.ts`. Applied migrations are recorded in
`schema_migrations`, which is also what the health probe reads — a database that
is up but has never been migrated reports as unreachable rather than healthy.

Tests get their own Postgres from Testcontainers (`database/database.test.ts`),
so a green `pnpm test` needs a Docker daemon but never `docker compose up`.

## Routes

| Method | Path      | Description                                                     |
| ------ | --------- | --------------------------------------------------------------- |
| GET    | `/health` | `200` with the health report, `503` when a dependency is down.   |
| GET    | `/docs`   | Scalar API reference, generated from the `HttpApi` definition.  |

The OpenAPI document is derived from the endpoint schemas, so documenting a new
route means annotating it in the module's `api.ts` — nothing to keep in sync.
Scalar's script is inlined from `@effect/platform`, so the page loads offline.

## Scripts

```sh
pnpm dev        # watch mode (Node strips the types)
pnpm build      # tsc -> dist/
pnpm start      # run the build
pnpm test       # vitest
pnpm typecheck
```

## Configuration

| Variable            | Default     | Purpose                          |
| ------------------- | ----------- | -------------------------------- |
| `PORT`              | `3000`      | Port the server binds to         |
| `HOST`              | `0.0.0.0`   | Interface the server binds to    |
| `DATABASE_HOST`     | `localhost` | Postgres host                    |
| `DATABASE_PORT`     | `5432`      | Postgres port                    |
| `DATABASE_NAME`     | _required_  | Database name                    |
| `DATABASE_USER`     | _required_  | Database user                    |
| `DATABASE_PASSWORD` | _required_  | Database password                |
| `DATABASE_SSL`      | `false`     | Connect over TLS                 |

The credentials have no defaults on purpose: an unconfigured deployment should
fail to boot rather than quietly try a well-known password. `pnpm dev` and
`pnpm start` load the repo-root `.env` if it exists, which is the same file
Compose reads.
