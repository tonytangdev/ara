# @ara/api

Effect TS HTTP API, organised as a hexagon.

## Layout

Module-first: each feature owns its own hexagon.

```
src/
  connections/                 the connections module: Users, sign-in, Forge authorization
    api.ts                       its HTTP contract, incl. the session middleware
    index.ts                     its public face: `ConnectionsLive`, fully wired
    domain/
      user.ts, session.ts, installation.ts, forge-credential.ts
      repository.ts, repo-connection.ts
      ports/                     driven ports: repositories, `GithubAuthorization`,
                                 `InstallationTokens`, `ReachableRepositories`
    application/                 one file per use case
    infrastructure/
      http/                        handlers + the session authentication middleware
      github/                      GitHub App adapters (OAuth exchange, App JWT, tokens)
      persistence/                 Postgres adapters
      crypto/secret-cipher.ts      AES-256-GCM, used by the persistence adapters
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

| Method | Path                              | Description                                                    |
| ------ | --------------------------------- | -------------------------------------------------------------- |
| GET    | `/health`                         | `200` with the health report, `503` when a dependency is down.  |
| GET    | `/docs`                           | Scalar API reference, generated from the `HttpApi` definition. |
| GET    | `/v1/auth/github`                 | `302` to GitHub, carrying a state cookie for the return trip.   |
| GET    | `/v1/auth/github/callback`        | Completes sign-in and sets the session cookie.                  |
| GET    | `/v1/auth/github/installation`    | Where GitHub sends someone after installing the App.            |
| GET    | `/v1/me`                          | The signed-in User; `401` without a valid session.              |
| GET    | `/v1/repositories`                | Repositories the caller's installations can reach.              |
| POST   | `/v1/repo-connections`            | `201` with the Repo Connection; `422` if it is not reachable.   |
| GET    | `/v1/repo-connections`            | The caller's Repo Connections, and nobody else's.               |
| DELETE | `/v1/repo-connections/:id`        | `204`, or `404` if the caller does not own one with that id.    |

Everything new lives under `/v1`. `/health` stays unversioned because platform
probes depend on the path.

## Signing in

Ara authorizes as a **GitHub App**, not an OAuth App
([ADR-0005](../../docs/adr/0005-github-app-not-oauth-app.md)). Four consequences
run through the connections module:

- **Identity and access are separate.** Signing in creates a User; installing
  the App is a second, optional act. `GET /v1/me` answers with
  `installations: []` for someone who has done only the first, because that is a
  complete answer rather than an error.
- **Nothing long-lived is stored.** Installation tokens are minted from the
  App's private key when a repository is read and refreshed before they expire;
  they never reach a column. The user access token that *is* kept is encrypted
  with `CREDENTIAL_ENCRYPTION_KEY`, and sessions are stored only as a digest of
  the token the browser holds.
- **Nothing secret reaches a log.** Credentials are `Redacted`, and request
  logging goes through `http/logging.ts`, which replaces the `code` and `state`
  parameters GitHub puts on the callback URL.
- **What Ara can reach is an authorization question.** `GET /v1/repositories`
  asks the installation what it can see rather than asking GitHub what the
  person owns, because repository selection happens on GitHub's installation
  screen. Connecting is checked against that list, so a Repo Connection always
  means Ara can read the repository today.
- **Authorization is GitHub-shaped and stays outside the Activity port.**
  `GithubAuthorization` and `InstallationTokens` are named for the Forge on
  purpose; `RepoActivitySource` will ask this module for a credential rather
  than owning one ([ADR-0003](../../docs/adr/0003-forge-agnostic-ports.md)).

## Repo Connections

A Repo Connection is a User's authorized link to one repository, and owning it
is what entitles that User to Digests and Drafts for it. Repository identity is
`(forge, owner, name)` — three columns, never a parsed `owner/name` string
([ADR-0003](../../docs/adr/0003-forge-agnostic-ports.md)).

Ownership is enforced in the SQL rather than by a check somebody has to
remember: every statement in `pg-repo-connection-repository.ts` carries
`user_id`, so a lookup by id alone is not expressible. Asking about somebody
else's connection and asking about one that never existed give the same 404.

What is stored against a connection is which installation it reads through, not
a credential; the token is minted when a repository is actually read. Deleting a
connection stops Ara reading the repository from then on and leaves the Drafts
already generated intact — Runs and Drafts keep their own copy of the repository
identity and let go of the connection.

Local development needs a real GitHub App and a callback URL that reaches your
machine. See `.env.example` for the four values it wants.

## Building a Digest

A Digest covers **every branch**, not the repository's default branch, and a
commit counts on the day of its **author date**
([ADR-0006](../../docs/adr/0006-the-digest-reads-every-branch.md)). Reading the
default branch alone was GitHub's default rather than a decision, and it cost a
day on a feature branch three quarters of its work. The adapter asks which
branches exist — the default branch by name, so a crowded branch list cannot
lose it — reads each one's commits, and deduplicates by sha; the author date is
what stops a squash or a rebase reporting a week of branch work again on the day
it landed. Every branch costs a call, so the fan-out is bounded at 50 branches
and metered like every other read.

## Writing a Draft

The second stage of a Run reads the Digest the first stage persisted and writes
prose from it ([ADR-0002](../../docs/adr/0002-digest-draft-split.md)). It never
goes back to the Forge, which is what makes regenerating a Draft cheap, and it
is given the Digest and nothing else — no source code reaches a language model
([ADR-0004](../../docs/adr/0004-no-diffs-in-the-digest.md)).

The model sits behind the `DraftWriter` port. The adapter above it knows
`@effect/ai`'s provider-agnostic `LanguageModel` tag and nothing about any
provider; `drafts/infrastructure/ai/openrouter.ts` is the only file that names
one, and both which model and where to reach it are configuration. Application
tests provide a scripted `DraftWriter` and never make a real model call.

One rule the module exists to keep: a response can be a perfectly good HTTP 200
carrying reasoning and **no message content**. The prototype saw it once in
twenty-four calls. It is caught at the adapter, again before anything is
persisted, and refused a third time by a `check` constraint on the table — a
Run fails without a Draft rather than succeeding with an empty one.

### Rate limits and what a Run costs

Both outbound adapters meter themselves. GitHub is limited **per App
installation** (ADR-0005), so one busy User spends their own quota and nobody
else's; the model has one budget, because that bill is Ara's own. Both bound a
single call with a timeout that covers waiting for a turn as well as the call
itself, so a spent budget and a provider that stopped answering come out the
same way: a *retryable* failure at the port, for the Run lifecycle to act on.
None of this is visible at a call site — a use case asks for Activity or for
prose and gets one or the other.

A Draft records the tokens it used, the reasoning tokens among them, and what
that came to in dollars at the configured prices. The Run carries the same
figures, because the Run id is the one a User holds: `GET /v1/runs/:id` answers
what yesterday's post cost without anybody having to find a Draft first.
Reasoning tokens are a *breakdown* of the output tokens rather than an addition
to them, so they are reported and not re-charged — on a reasoning model they are
most of the bill either way, which is why they get a line of their own.

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
| `GITHUB_APP_ID`     | _required_  | The GitHub App's numeric id      |
| `GITHUB_APP_CLIENT_ID`     | _required_ | The App's client id       |
| `GITHUB_APP_CLIENT_SECRET` | _required_ | The App's client secret   |
| `GITHUB_APP_PRIVATE_KEY`   | _required_ | PEM, base64 or `\n`-escaped |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub's API |
| `GITHUB_WEB_BASE_URL` | `https://github.com` | Where people sign in |
| `CREDENTIAL_ENCRYPTION_KEY` | _required_ | 32 bytes, base64      |
| `SESSION_LIFETIME`  | `30 days`   | How long a session lasts         |
| `SESSION_SECURE_COOKIES` | `true` | `Secure` on the session cookie  |
| `AFTER_SIGN_IN_URL` | `/v1/me`    | Where sign-in sends the browser  |
| `OPENROUTER_API_KEY` | _required_ | Where the model is reached      |
| `OPENROUTER_API_URL` | `https://openrouter.ai/api/v1` | The provider's base URL |
| `DRAFT_MODEL`       | `moonshotai/kimi-k3` | Which model writes a Draft |
| `RUN_MAX_ATTEMPTS` | `5`          | Attempts before a Run gives up      |
| `RUN_RETRY_BASE_DELAY` | `2 seconds` | First backoff; doubles with jitter |
| `RUN_RETRY_MAX_DELAY` | `2 minutes` | Where the doubling stops           |
| `GITHUB_RATE_LIMIT` | `5000`   | Calls allowed per installation      |
| `GITHUB_RATE_LIMIT_INTERVAL` | `1 hour` | The window that budget covers |
| `GITHUB_REQUEST_TIMEOUT` | `30 seconds` | One GitHub call, waiting for a turn included |
| `MODEL_RATE_LIMIT` | `20`         | Model calls allowed per interval    |
| `MODEL_RATE_LIMIT_INTERVAL` | `1 minute` | The window that budget covers |
| `MODEL_REQUEST_TIMEOUT` | `2 minutes` | One model call, waiting for a turn included |
| `MODEL_INPUT_USD_PER_MILLION_TOKENS` | `0.6` | What input tokens cost |
| `MODEL_OUTPUT_USD_PER_MILLION_TOKENS` | `2.5` | What output tokens cost |

The credentials have no defaults on purpose: an unconfigured deployment should
fail to boot rather than quietly try a well-known password. `pnpm dev` and
`pnpm start` load the repo-root `.env` if it exists, which is the same file
Compose reads.
