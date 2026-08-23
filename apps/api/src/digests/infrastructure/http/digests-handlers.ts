import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { CurrentUser } from "../../../connections/domain/current-user.ts"
import { AraApi } from "../../../http/api.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import { DigestResponse, NoSuchDigest } from "../../api.ts"
import { DescribeDigest } from "../../application/describe-digest.ts"
import type { StoredDigest } from "../../domain/digest.ts"

const toResponse = ({ collectedAt, digest, id, runId }: StoredDigest) =>
  new DigestResponse({
    id,
    runId,
    forge: digest.repo.forge,
    owner: digest.repo.owner,
    name: digest.repo.name,
    day: digest.day,
    commitCount: digest.commitCount,
    commits: digest.commits,
    pullRequests: digest.pullRequests,
    totals: digest.totals,
    topAreas: digest.topAreas,
    topFiles: digest.topFiles,
    isQuiet: digest.isQuiet,
    collectedAt
  })

/**
 * Driving (inbound) adapter for Digests.
 *
 * The User is taken from `CurrentUser` and never from anything the caller sent,
 * so a Digest cannot be read by guessing a Run id. "Not yours", "no such Run"
 * and "nothing collected yet" arrive here as one domain failure and leave as
 * one 404.
 */
export const DigestsHandlersLive = HttpApiBuilder.group(AraApi, "digests", (handlers) =>
  handlers.handle("read", ({ path }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const describe = yield* DescribeDigest

      const stored = yield* describe
        .execute(user, path.id as RunId)
        .pipe(Effect.mapError(() => new NoSuchDigest({ message: "No such Digest" })))

      return toResponse(stored)
    })
  )
)
