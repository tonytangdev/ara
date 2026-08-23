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
      system/process-system-probe.ts   driven adapter (Node `process`)
  http/
    api.ts                     composes each module's group into one HttpApi
    server.ts                  composes each module's layers, then listens
  config.ts
  main.ts                      composition root
```

Dependencies point inwards: `infrastructure → application → domain`. Adapters are
swapped by providing a different `Layer` — the use case test does exactly that
with a stub `SystemProbe`.

Nothing outside a module should import deeper than its `api.ts` or `index.ts`.
Adding a feature means adding one folder plus two lines in `http/`.

## Routes

| Method | Path      | Description                                                     |
| ------ | --------- | --------------------------------------------------------------- |
| GET    | `/health` | `200` with the health report, `503` when a dependency is down.   |

## Scripts

```sh
pnpm dev        # watch mode (Node strips the types)
pnpm build      # tsc -> dist/
pnpm start      # run the build
pnpm test       # vitest
pnpm typecheck
```

`PORT` (default `3000`) and `HOST` (default `0.0.0.0`) configure the server.
