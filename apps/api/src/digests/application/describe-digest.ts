import { Effect, Option } from "effect"
import type { User } from "../../connections/domain/user.ts"
import type { RunId } from "../../runs/domain/run.ts"
import { DigestNotFound, type StoredDigest } from "../domain/digest.ts"
import { DigestRepository } from "../domain/ports/digest-repository.ts"

/**
 * Driving (inbound) port: what did Ara decide happened that day?
 *
 * A Digest is read through the Run that produced it, because the Run is what
 * the User asked for and what they hold an id to. A Run that is not theirs, and
 * one that has not collected anything yet, fail identically to one that never
 * existed.
 */
export class DescribeDigest extends Effect.Service<DescribeDigest>()("application/digests/DescribeDigest", {
  effect: Effect.gen(function* () {
    const digests = yield* DigestRepository

    const execute = (user: User, runId: RunId): Effect.Effect<StoredDigest, DigestNotFound> =>
      Effect.flatMap(
        digests.findForRun(runId, user.id),
        Option.match({
          onNone: () => Effect.fail(new DigestNotFound()),
          onSome: Effect.succeed
        })
      )

    return { execute } as const
  })
}) {}
