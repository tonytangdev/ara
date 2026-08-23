import { Effect, Option } from "effect"
import type { User } from "../../connections/domain/user.ts"
import type { RunId } from "../../runs/domain/run.ts"
import { type DraftId, DraftNotFound, type StoredDraft } from "../domain/draft.ts"
import { DraftRepository } from "../domain/ports/draft-repository.ts"

/**
 * Driving (inbound) port: what did Ara write for that day?
 *
 * A Draft is reached two ways, because there are two ways a User arrives at
 * one: through the Run they just asked for and hold an id to, or by its own id,
 * picked out of the list of everything they have accumulated.
 *
 * Both fail identically for every reason they can fail — not theirs, never
 * existed, nothing written yet — so asking cannot confirm somebody else's Draft
 * is there.
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

    /** One Draft, by its own id: what the list links to. */
    const byId = (user: User, id: DraftId): Effect.Effect<StoredDraft, DraftNotFound> =>
      Effect.flatMap(
        drafts.findOwnedBy(id, user.id),
        Option.match({
          onNone: () => Effect.fail(new DraftNotFound()),
          onSome: Effect.succeed
        })
      )

    return { execute, byId } as const
  })
}) {}
