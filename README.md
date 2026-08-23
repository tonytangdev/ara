# ara

pnpm monorepo.

## Layout

- `apps/*` — deployable applications
- `packages/*` — shared libraries

## Getting started

```sh
pnpm install
```

Scripts at the root fan out to every workspace package: `pnpm build`, `pnpm dev`,
`pnpm test`, `pnpm lint`, `pnpm typecheck`.

## Adding a package

```sh
mkdir -p packages/my-lib && cd packages/my-lib && pnpm init
```

Then depend on it from another workspace with `pnpm add my-lib --workspace --filter my-app`.
