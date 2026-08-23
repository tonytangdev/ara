import { FetchHttpClient } from "@effect/platform"
import { Layer } from "effect"
import { InstallationTokensLive, RepoConnectionRepositoryLive } from "../connections/index.ts"
import { BuildDigest } from "./application/build-digest.ts"
import { CollectDigest } from "./application/collect-digest.ts"
import { DescribeDigest } from "./application/describe-digest.ts"
import { GithubRepoActivitySourceLive } from "./infrastructure/github/github-repo-activity-source.ts"
import { DigestsHandlersLive } from "./infrastructure/http/digests-handlers.ts"
import { PgDigestRepositoryLive } from "./infrastructure/persistence/pg-digest-repository.ts"

/**
 * GitHub behind the Forge-agnostic port (ADR-0003). `InstallationTokensLive` is
 * the connections module's own layer rather than a copy of it, so the token
 * cache is shared with everything else that talks to GitHub: reading a day of
 * Activity does not mint a second token beside the one already held.
 */
const RepoActivitySourceLive = GithubRepoActivitySourceLive.pipe(
  Layer.provide(InstallationTokensLive),
  Layer.provide(FetchHttpClient.layer)
)

/**
 * The digests module's public face. Nothing outside this folder should import
 * anything deeper than these exports:
 *
 * - `./api.ts` — the HTTP contract this module contributes to the API surface.
 * - `DigestsLive` — reading a Digest over HTTP, fully wired.
 * - `CollectDigestLive` — the collect stage of a Run, for the worker to call.
 *
 * They are two layers because they are two callers: a User reading yesterday's
 * Digest needs a database and nothing else, while collecting one needs GitHub.
 * `SqlClient` is left as a requirement, so the composition root decides which
 * Postgres the module reads and writes.
 */
export const DigestsLive = DigestsHandlersLive.pipe(
  Layer.provide(DescribeDigest.Default),
  Layer.provide(PgDigestRepositoryLive)
)

/** The collect stage: read a Day Window's Activity, build a Digest, persist it. */
export const CollectDigestLive = CollectDigest.Default.pipe(
  Layer.provide(BuildDigest.Default),
  Layer.provide(Layer.mergeAll(RepoActivitySourceLive, PgDigestRepositoryLive, RepoConnectionRepositoryLive))
)

export { DigestResponse, DigestsApiGroup, NoSuchDigest } from "./api.ts"
export { BuildDigest } from "./application/build-digest.ts"
export { CollectDigest } from "./application/collect-digest.ts"
export { Digest, StoredDigest } from "./domain/digest.ts"
export { RepoActivitySource } from "./domain/ports/repo-activity-source.ts"
