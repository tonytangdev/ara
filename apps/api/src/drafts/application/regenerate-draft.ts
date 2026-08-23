import { Effect, Option } from "effect"
import type { User } from "../../connections/domain/user.ts"
import { JobQueue } from "../../runs/domain/ports/job-queue.ts"
import type { Run, RunId } from "../../runs/domain/run.ts"
import { DraftEditNotConfirmed, type DraftId, DraftNotFound } from "../domain/draft.ts"
import { DraftRepository } from "../domain/ports/draft-repository.ts"

/** What the User said about the edit on the Draft they are asking to have written again. */
export interface RegenerateDraftOptions {
  /** True only when they were shown that a rewrite of their own exists and said to go ahead anyway. */
  readonly discardEdit: boolean
}

/**
 * Driving (inbound) port: write this day again, from the Digest we already
 * have.
 *
 * This is where ADR-0002 is cashed in. The expensive, rate-limited half of a
 * Run is the read of the Forge, and it is already persisted, so a User who does
 * not like a Draft pays for one model call and no Forge calls to get another
 * take. Nothing here reads a Repo Connection either, which means a day stays
 * rewritable after the repository has been disconnected.
 *
 * It answers with a Run rather than a Draft because writing takes as long as it
 * takes: the same asynchronous shape as asking for a Run in the first place,
 * polled the same way, retried by the same single policy the Run lifecycle owns
 * (#12). There is deliberately no retry, no model call and no Forge call in
 * this file — regeneration is an ordinary Run with its collect stage already
 * done, and anything else here would be a second lifecycle to keep in step with
 * the first.
 *
 * Nothing is deleted. The Draft being regenerated stays exactly where it is,
 * edit and all, so "go back to the one I preferred" is a read rather than a
 * recovery (user story 20).
 */
export class RegenerateDraft extends Effect.Service<RegenerateDraft>()("application/drafts/RegenerateDraft", {
  effect: Effect.gen(function* () {
    const drafts = yield* DraftRepository
    const queue = yield* JobQueue

    const execute = (
      user: User,
      id: DraftId,
      options: RegenerateDraftOptions
    ): Effect.Effect<Run, DraftNotFound | DraftEditNotConfirmed> =>
      Effect.gen(function* () {
        // Not theirs and never existed fail identically, as everywhere else, so
        // regeneration cannot be used to find out that somebody else's Draft is
        // there — and cannot spend anything on it either.
        const draft = yield* Effect.flatMap(
          drafts.findOwnedBy(id, user.id),
          Option.match({
            onNone: () => Effect.fail(new DraftNotFound()),
            onSome: Effect.succeed
          })
        )

        if (draft.editedBody !== null && !options.discardEdit) {
          return yield* Effect.fail(new DraftEditNotConfirmed())
        }

        const run = yield* queue.enqueueRegeneration({
          userId: user.id,
          sourceRunId: draft.runId as RunId,
          digestId: draft.digestId
        })

        yield* Effect.logInfo("A User asked for a Draft to be written again").pipe(
          Effect.annotateLogs({
            userId: user.id,
            draftId: draft.id,
            digestId: draft.digestId,
            runId: run.id,
            wasEdited: draft.editedBody !== null
          })
        )

        return run
      })

    return { execute } as const
  })
}) {}
