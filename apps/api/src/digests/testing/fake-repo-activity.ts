import { Effect, Layer } from "effect"
import { RepoConnectionRepositoryLive } from "../../connections/index.ts"
import { BuildDigest } from "../application/build-digest.ts"
import { CollectDigest } from "../application/collect-digest.ts"
import { RepositoryActivity } from "../domain/activity.ts"
import { type ActivityRequest, ActivityUnavailable, RepoActivitySource } from "../domain/ports/repo-activity-source.ts"
import { PgDigestRepositoryLive } from "../infrastructure/persistence/pg-digest-repository.ts"

/**
 * A Forge that answers from a fixture instead of over the network.
 *
 * Shared rather than rewritten per test file because several tests need a Run
 * to be able to finish and are not about what it found: the Run spine's tests,
 * the worker's lifecycle test, and the Digest's own end-to-end walk. Kept out
 * of `src/**` builds by `tsconfig.build.json`.
 */
export const repoActivitySourceOf = (activity: (request: ActivityRequest) => RepositoryActivity) =>
  Layer.succeed(
    RepoActivitySource,
    RepoActivitySource.of({ activityFor: (request) => Effect.succeed(activity(request)) })
  )

/** A day on which nothing at all happened. A Digest, and never a failure. */
export const emptyRepoActivitySource = repoActivitySourceOf(
  ({ dayWindow, repository }) => new RepositoryActivity({ repository, dayWindow, commits: [], pullRequests: [] })
)

/**
 * A Forge that will not answer, and says why.
 *
 * The failure carries its own classification, exactly as the GitHub adapter's
 * does, because whether a Run should try again is the adapter's judgement and
 * not the test's.
 */
export const repoActivitySourceFailing = (failure: ActivityUnavailable) =>
  Layer.succeed(RepoActivitySource, RepoActivitySource.of({ activityFor: () => Effect.fail(failure) }))

/** Access is gone rather than shaky: a Run that meets this stops instead of retrying. */
export const unreachableRepoActivitySource = repoActivitySourceFailing(
  new ActivityUnavailable({
    reason: "Ara can no longer reach octocat/ara. Its access to the repository may have been revoked.",
    retryable: false
  })
)

/** The collect stage, reading from a fixture and writing to a real database. */
export const collectDigestOver = (source: Layer.Layer<RepoActivitySource>) =>
  CollectDigest.Default.pipe(
    Layer.provide(BuildDigest.Default),
    Layer.provide(Layer.mergeAll(source, PgDigestRepositoryLive, RepoConnectionRepositoryLive))
  )
