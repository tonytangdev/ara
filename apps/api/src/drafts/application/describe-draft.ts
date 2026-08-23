import { Effect, Option } from "effect"
import type { User } from "../../connections/domain/user.ts"
import type { RunId } from "../../runs/domain/run.ts"
import { DraftNotFound, type StoredDraft } from "../domain/draft.ts"
import { DraftRepository } from "../domain/ports/draft-repository.ts"

/**
 * Driving (inbound) port: what did Ara write for that day?
 *
 * A Draft is read through the Run that produced it, because the Run is what the
 * User asked for and what they hold an id to. Listing Drafts and reading one by
 * its own id is #9. A Run that is not theirs, and one that has not written
 * anything yet, fail identically to one that never existed.
 */
export class DescribeDraft extends Effect.Service<DescribeDraft>()("application/drafts/DescribeDraft", {
  effect: Effect.gen(function* () {
    const drafts = yield* DraftRepository

    const execute = (user: User, runId: RunId): Effect.Effect<StoredDraft, DraftNotFound> =>
      Effect.flatMap(
        drafts.latestForRun(runId, user.id),
        Option.match({
          onNone: () => Effect.fail(new DraftNotFound()),
          onSome: Effect.succeed
        })
      )

    return { execute } as const
  })
}) {}
