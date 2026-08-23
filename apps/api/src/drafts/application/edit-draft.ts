import { Effect, Option } from "effect"
import type { User } from "../../connections/domain/user.ts"
import { type DraftId, DraftNotFound, type StoredDraft } from "../domain/draft.ts"
import { DraftRepository } from "../domain/ports/draft-repository.ts"

/**
 * Driving (inbound) port: the Draft becomes the thing the User actually posts.
 *
 * The edit is stored beside the generated prose, never over it. That is the
 * whole shape of this use case, and it is load-bearing twice over: regeneration
 * has to be able to tell that a human has been here before it writes anything
 * (#11), and "what does this User always change?" is only answerable while both
 * versions still exist (user story 18).
 *
 * Nothing else about the Draft moves. The Digest it was written from, the model
 * that wrote it and what that cost are facts about how it came to exist, and
 * editing the prose does not make any of them untrue.
 *
 * Not theirs and never existed fail identically, as everywhere else, so editing
 * cannot be used to find out that somebody else's Draft is there.
 */
export class EditDraft extends Effect.Service<EditDraft>()("application/drafts/EditDraft", {
  effect: Effect.gen(function* () {
    const drafts = yield* DraftRepository

    const execute = (user: User, id: DraftId, body: string): Effect.Effect<StoredDraft, DraftNotFound> =>
      Effect.flatMap(
        drafts.saveEdit(id, user.id, body),
        Option.match({
          onNone: () => Effect.fail(new DraftNotFound()),
          onSome: (draft) =>
            Effect.as(Effect.logInfo("A User edited a Draft").pipe(Effect.annotateLogs({ draftId: draft.id })), draft)
        })
      )

    return { execute } as const
  })
}) {}
