# Spec: Turn a day of repository Activity into a Draft

## Problem Statement

I build things constantly and tell almost nobody. Building in public is supposed
to be a habit, but every post starts from a blank page at the end of a day when
I am out of energy, and reconstructing what I actually did means scrolling my own
commit history and trying to remember why any of it mattered. So I skip it. Weeks
of real work go unmentioned, and the projects look abandoned to anyone watching.

The work is already recorded. It is sitting in the Forge in full detail. The
missing piece is not information, it is the act of writing it down.

## Solution

Ara reads a Day Window of Activity from a repository I have connected, builds a
Digest of what actually happened, and writes a Draft build-in-public post from
it. I read the Draft, edit it if I want, and post it wherever I like.

For the MVP I ask for a Run myself. The Run is asynchronous: I get a Run id back
immediately and poll it until a Draft exists. If the day was light, Ara says so
in a few honest sentences rather than inflating two commits into a fake
milestone.

## User Stories

### Connecting a repository

1. As a User, I want to connect a repository from a Forge, so that Ara can read
   the Activity it will write about.
2. As a User, I want to connect a private repository, so that the work I actually
   do during the day is eligible, not just my public side projects.
3. As a User, I want to list my Repo Connections, so that I can see what Ara is
   watching.
4. As a User, I want to remove a Repo Connection, so that Ara stops having access
   to a repository I no longer want it to read.
5. As a User, I want Ara to store a reference to my authorization rather than a
   long-lived token, so that a database leak does not hand over my source code.
6. As a User, I want a Repo Connection to record which Forge it belongs to, so
   that connecting a GitLab repository later does not require re-modelling my
   account.
7. As a User, I want to be told clearly when Ara can no longer access a connected
   repository, so that I am not silently getting nothing.

### Asking for a Draft

8. As a User, I want to request a Run for a specific repository and Day Window,
   so that I can write about a day that is not today.
9. As a User, I want the request to return immediately with a Run id, so that my
   client is not holding a connection open for a minute.
10. As a User, I want to poll a Run and see what stage it is at, so that I know
    whether it is still working or has finished.
11. As a User, I want a Run that is already in flight for the same repository and
    Day Window to be returned rather than duplicated, so that double-clicking
    does not cost me two model calls.
12. As a User, I want to list my recent Runs, so that I can find a Draft I
    generated earlier.
13. As a User, I want to request a Run for a Day Window in my own timezone, so
    that "yesterday" means what I think it means.
14. As a User, I want to be refused clearly when I request a Run for a repository
    I have not connected, so that I am not left guessing.

### Reading and editing a Draft

15. As a User, I want to read the Draft a Run produced, so that I can decide
    whether to post it.
16. As a User, I want the Draft in markdown, so that I can paste it into whatever
    platform I use.
17. As a User, I want to edit a Draft and save my changes, so that the Draft
    becomes the thing I actually post.
18. As a User, I want my edits kept separately from what was originally
    generated, so that Ara can later learn what I always change.
19. As a User, I want to regenerate a Draft from the same Digest, so that I can
    get a different take without paying for another read of the Forge.
20. As a User, I want regeneration to keep the earlier Drafts, so that I can go
    back to one I preferred.
21. As a User, I want a Draft to be roughly 150-250 words, so that it is postable
    without further cutting.
22. As a User, I want the Draft to sound like a developer talking to other
    developers, so that I am not embarrassed to publish it.

### Honesty and Quiet Days

23. As a User, I want Ara to never invent features, metrics or motivations that
    are not in my Activity, so that I do not publish something false about my own
    project.
24. As a User, I want a light day to produce a short, honest Quiet Draft, so that
    I can still post something without pretending two commits were a milestone.
25. As a User, I want a day with no Activity at all to end the Run cleanly as a
    Quiet Day, so that I get a clear answer rather than an error.
26. As a User, I want the threshold for a Quiet Day to be tunable, so that it can
    be corrected once I have seen it fire a few times.
27. As a User, I want bot commits excluded from my Digest, so that Ara does not
    write about Dependabot's day.
28. As a User, I want lockfile-only churn excluded, so that a dependency bump does
    not dominate the post.
29. As a User, I want merge commits excluded, so that the Digest reflects work
    rather than branch mechanics.

### Trust and cost

30. As a User, I want my source code never sent to a language model, so that
    connecting a private repository is not a disclosure decision.
31. As a User, I want to see which model wrote a Draft, so that I can compare
    quality when the model changes.
32. As a User, I want token usage recorded per Draft, so that the cost of the
    habit is visible.

### Operating it

33. As an operator, I want the API and the worker to run in one process, so that
    the MVP is one thing to deploy.
34. As an operator, I want a Run interrupted by a deploy to be picked up again
    afterwards, so that restarting does not silently lose work.
35. As an operator, I want transient Forge and model failures retried
    automatically, so that a 502 does not become a failed Run.
36. As an operator, I want terminal failures to stop immediately rather than
    retry, so that a revoked authorization does not burn quota.
37. As an operator, I want the unversioned health endpoint left alone, so that
    existing platform probes keep working.
38. As an operator, I want database schema changes applied on boot, so that
    deploying is a single step.

## Implementation Decisions

### Modules

Three new modules alongside the existing health module, each following the same
hexagonal layout (`domain`, `domain/ports`, `application`, `infrastructure`,
`api.ts`, `index.ts`) and each exposing exactly two things to the outside: its
HTTP contract and its fully-wired Layer.

- **connections** — Users, Repo Connections, Forge authorization.
- **digests** — Activity collection and Digest construction.
- **drafts** — Draft generation, editing, regeneration.

Runs are the thread that ties them together and are owned by a fourth concern,
**runs**, which holds the Run lifecycle and the job queue.

### Package layout

Domain, application and ports move into a shared `packages/core`. `apps/api`
and `apps/worker` become thin entrypoints over it. For the MVP only `apps/api`
is deployed, and it runs both the HTTP server and the worker in one process by
merging their Layers into a single launch. `apps/worker` exists so that splitting
them across machines later is a deployment change rather than a refactor.

### Ports

Four driven ports, all named for what the domain needs rather than who provides
them, per ADR-0003.

- **`RepoActivitySource`** — given a repository and a Day Window, return the
  Activity. Backed by GitHub for the MVP. Authorization is deliberately *not*
  behind this port; it stays Forge-specific.
- **`DraftWriter`** — given a Digest and a Draft shape, return prose. Backed by
  `@effect/ai` with the OpenRouter provider.
- **`JobQueue`** — enqueue and claim Runs. Backed by Postgres per ADR-0001.
- Repository ports for Users, Repo Connections, Digests, Drafts and Runs.

### The Run pipeline

A Run is two stages with a persisted boundary between them, per ADR-0002:

1. **Collect** — read Activity via `RepoActivitySource`, build a Digest, persist
   it. Deterministic, no model involved.
2. **Draft** — read the persisted Digest, call `DraftWriter`, persist the Draft.

Stage 2 can be re-run against a stored Digest without touching the Forge. This is
both the regenerate feature and the crash-recovery boundary.

Run states: `queued`, `collecting`, `drafting`, `succeeded`, `failed`, `quiet`.
`quiet` is a successful outcome, not a failure, and still carries a Quiet Draft
when there was any Activity at all.

### The worker

The worker's unit of work is a callable use case that claims and processes one
Run. The long-lived fiber is a thin loop around it, forked into the application
Layer's scope so it starts with the app and is interrupted on shutdown. Tests
call the use case directly and never fork a fiber.

Runs are claimed with `SELECT ... FOR UPDATE SKIP LOCKED`. On boot, Runs left in
`collecting` or `drafting` are returned to `queued`, which is what makes an
interrupted deploy recoverable. Because a Run can therefore execute more than
once, processing must be idempotent, and the Digest boundary is what makes that
affordable.

### Digest shape

The Digest schema is the load-bearing decision of the feature and was validated
by prototype before being specified. Shape, from the prototype:

```
{
  repo, day,
  commitCount,
  commits:      [{ subject, files: [path] }],
  pullRequests: [{ number, title, kind }],
  totals:       { filesTouched, additions, deletions },
  topAreas:     [{ dir, churn }],
  topFiles:     [{ path, additions, deletions }]
}
```

Commit *subjects* only, not full messages. Paths and churn, never diff hunks
(ADR-0004). Bot commits, merge commits and lockfile paths are filtered during
construction, not at query time.

### Quiet Day

Whether a Day Window is a Quiet Day is decided during Digest construction, before
any model call, so it is deterministic and unit-testable. Initial threshold:
fewer than three commits and under fifty changed lines, both configurable. A
Quiet Day produces a Quiet Draft of 40-90 words with an instruction that
explicitly permits a light day and forbids padding. The prototype established
that the word-count floor of a normal Draft is what drives the model to fabricate
detail on thin input, so the shorter target is a correctness measure, not a
stylistic one.

### API contract

All endpoints under `/v1`. The existing `/health` stays unversioned at the root
because platform probes depend on the path.

- `POST /v1/repo-connections` — create a Repo Connection
- `GET /v1/repo-connections` — list the caller's Repo Connections
- `DELETE /v1/repo-connections/:id` — remove one
- `POST /v1/repo-connections/:id/runs` — request a Run for a Day Window;
  returns 202 with a Run id; returns the in-flight Run if one exists for the same
  repository and Day Window
- `GET /v1/runs/:id` — Run state and, when finished, the Draft id
- `GET /v1/runs` — recent Runs for the caller
- `GET /v1/drafts/:id` — Draft text and metadata
- `PATCH /v1/drafts/:id` — save the User's edited text alongside the generated text
- `POST /v1/drafts/:id/regenerate` — new Draft from the same Digest
- The Forge authorization callback

### Persistence

Postgres via `@effect/sql-pg`, raw SQL, no ORM, with the package's own migrator
run at boot before the server binds. SQL never appears outside the repository
adapters.

### Model

`@effect/ai` with `@effect/ai-openrouter`, model `moonshotai/kimi-k3`.
Application code depends only on the provider-agnostic language model tag; the
provider is injected at the edge. Note that going direct to Moonshot would not
work: `@effect/ai-openai` speaks only the Responses API and Moonshot implements
only Chat Completions.

The `DraftWriter` adapter must treat a response with null content as a retryable
failure. The prototype saw this happen once in twenty-four calls; it is not an
HTTP error, so a naive implementation would persist an empty Draft.

Model name and token counts are persisted on each Draft.

### Failure handling

Retryable — rate limits, 5xx, timeouts, null model content — retry with
exponential backoff and jitter, up to five attempts. Terminal — revoked
authorization, deleted repository, invalid configuration — fail the Run
immediately without retrying.

## Testing Decisions

A good test here drives the system the way something outside it would and asserts
on what comes back. It does not reach into internals, does not assert on the
number of calls made to a port, and does not break when a module is reorganised.
The existing health module is the model: both of its tests would survive a total
rewrite of the code beneath them.

**Seam 1 — the HTTP API.** Prior art: `health-handlers.test.ts`, which builds a
test server and drives it through a typed client. Real handlers, real use cases,
real wiring; only the driven adapters are faked, with `RepoActivitySource`
returning fixture Activity and `DraftWriter` returning canned prose. One test
walks the whole feature: request a Run, process it, poll it to `succeeded`, read
the Draft. Others cover ownership, the in-flight deduplication, editing,
regeneration, and the Quiet Day path ending in a Quiet Draft.

Because the worker's unit of work is a callable use case, these tests invoke it
directly rather than forking the background fiber and polling for completion.
This is the reason for that design and the tests would be flaky without it.

**Seam 2 — Digest construction, at the application layer.** Prior art:
`check-health.test.ts`, which provides a fake port and asserts on the domain
object returned. Activity in, Digest out, pure, no model, no database. This is
where bot filtering, merge-commit and lockfile exclusion, area aggregation,
churn totals and the Quiet Day threshold are covered exhaustively. ADR-0004 makes
the Digest's exact contents a validated decision, so this is the test that stops
it drifting.

**One Testcontainers test** exercising the real SQL adapters and, specifically,
the `SKIP LOCKED` claim under two concurrent workers. ADR-0001 makes that query
load-bearing and an in-memory fake would never catch it breaking.

**One manually-run contract test** against real GitHub and a scratch repository,
excluded from CI, to catch the Forge changing its response shape.

No tests are written against the language model. Draft quality is not a unit test
and the prototype's blind comparison is the instrument for that question.

## Out of Scope

- **The scheduler.** No daily Runs, no per-User schedule, no timezone-aware due
  scan. Runs are triggered manually. Flagged honestly: without this, the MVP
  still requires the User to remember to ask, which is the behaviour the product
  exists to remove. It is deferred because Draft quality has to be proven first.
- **Notification.** No email, no Slack, no Telegram. Drafts are read through the API.
- **Publishing.** Ara never posts anywhere. No platform OAuth of any kind.
- **Style exemplars.** Voice is controlled by knobs, not by pasted samples of the
  User's own writing.
- **Diff-level summarization.** Excluded permanently, not deferred. See ADR-0004.
- **Per-User Run caps.**
- **Any Forge other than GitHub.** The ports are shaped for it; no adapter is built.
- **A frontend.** The API is the whole deliverable.
- **Login and signup.** The schema carries Users and ownership from day one, but
  there is no login UI; the first User is seeded directly.
- **Learning from User edits.** Edits are stored separately so this becomes
  possible later; nothing consumes them.

## Further Notes

The Digest/Draft split, the exclusion of diffs, and the Quiet Draft shape were all
settled by a throwaway prototype before this spec was written, not argued from
first principles. The prototype ran three input shapes past the same model over
eight real repository-days and had the author judge the output blind. The Digest
input won seven of seven judged days; the Digest-plus-diffs input was the worst
output on every day it was judged. That result reversed a design decision that
had already been made in the other direction.

Cost is higher than a naive estimate suggests. Kimi K3 is a reasoning model and
most of the tokens billed on a Draft are thinking tokens, putting a Draft at
roughly two to five cents rather than a fraction of one. Irrelevant at one User,
worth knowing before a scheduler fires daily for many.

Only one of the eight prototype days had any pull requests at all. Pull request
handling in the Digest is therefore the least evidenced part of this spec and the
most likely to need adjustment once real multi-day use begins.
