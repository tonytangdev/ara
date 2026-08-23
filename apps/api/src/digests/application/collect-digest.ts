import { Effect, Option } from "effect"
import { RepoConnectionRepository } from "../../connections/domain/ports/repo-connection-repository.ts"
import type { DigestRequest, StoredDigest } from "../domain/digest.ts"
import { DigestRepository } from "../domain/ports/digest-repository.ts"
import { ActivityUnavailable, RepoActivitySource } from "../domain/ports/repo-activity-source.ts"
import { BuildDigest } from "./build-digest.ts"

/**
 * Driving (inbound) port: the collect stage of a Run.
 *
 * Read the Day Window's Activity through the port, build a Digest from it, and
 * persist it. That is the whole of the deterministic half of a Run (ADR-0002),
 * and the persisted Digest is the boundary the Draft stage starts from: writing
 * a Draft again later costs one model call and no Forge calls.
 *
 * Everything decided about the day is decided in `BuildDigest`, which is pure.
 * What is left here is the two things that cannot be: reading, and writing.
 *
 * Collecting twice leaves one Digest, because a Run can be claimed twice — an
 * interrupted deploy hands its Runs back to the queue.
 */
export class CollectDigest extends Effect.Service<CollectDigest>()("application/digests/CollectDigest", {
  effect: Effect.gen(function* () {
    const connections = yield* RepoConnectionRepository
    const activity = yield* RepoActivitySource
    const build = yield* BuildDigest
    const digests = yield* DigestRepository

    const execute = (request: DigestRequest): Effect.Effect<StoredDigest, ActivityUnavailable> =>
      Effect.gen(function* () {
        // The Repo Connection is what authorizes reading the repository, so a
        // Run whose connection has been removed cannot be collected — even
        // though the Run itself survives the disconnection on purpose.
        const connection = yield* Effect.flatMap(
          request.repoConnectionId === null
            ? Effect.succeedNone
            : connections.findOwnedBy(request.repoConnectionId, request.userId),
          Option.match({
            onNone: () =>
              Effect.fail(
                new ActivityUnavailable({
                  reason:
                    `Ara is no longer connected to ${request.repository.owner}/${request.repository.name}. ` +
                    "Connect the repository again to write about it."
                })
              ),
            onSome: Effect.succeed
          })
        )

        const read = yield* activity.activityFor({
          repository: request.repository,
          dayWindow: request.dayWindow,
          installationExternalId: connection.installationExternalId
        })

        const digest = build.execute(read)
        const stored = yield* digests.save(request.runId, request.userId, digest)

        yield* Effect.logInfo("Collected a Digest").pipe(
          Effect.annotateLogs({
            runId: request.runId,
            digestId: stored.id,
            repository: `${request.repository.owner}/${request.repository.name}`,
            day: digest.day,
            commits: digest.commitCount,
            pullRequests: digest.pullRequests.length,
            filesTouched: digest.totals.filesTouched,
            quiet: digest.isQuiet
          })
        )

        return stored
      })

    return { execute } as const
  })
}) {}
