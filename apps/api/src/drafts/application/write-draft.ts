import { Effect, Option } from "effect"
import type { UserId } from "../../connections/domain/user.ts"
import { DigestRepository } from "../../digests/domain/ports/digest-repository.ts"
import type { RunId } from "../../runs/domain/run.ts"
import { isBlank, type StoredDraft, wordCount } from "../domain/draft.ts"
import { DraftRepository } from "../domain/ports/draft-repository.ts"
import { DraftUnavailable, DraftWriter } from "../domain/ports/draft-writer.ts"

/**
 * Which Run to write for. Not the `Run` itself: the drafts module answers
 * "write the post for this Run's Digest", and owes the runs module nothing
 * beyond that.
 */
export interface WriteDraftRequest {
  readonly runId: RunId
  readonly userId: UserId
}

/**
 * Driving (inbound) port: the Draft stage of a Run.
 *
 * Read the Digest that was persisted at the end of the collect stage, write
 * prose from it, persist that. The Forge is not touched here at all — that is
 * the point of the boundary in ADR-0002, and it is what makes regenerating a
 * Draft (#11) cost one model call and nothing else.
 *
 * Two rules are enforced above the port rather than inside any one adapter,
 * because they have to hold whichever model is behind it:
 *
 * - A Run that already has a Draft is left alone. A deploy that interrupts a
 *   Run hands it back to the queue, and processing it again must not buy a
 *   second model call or leave a second Draft.
 * - A Digest with no Activity in it is never written from. There is nothing to
 *   say about a day that contained nothing, and asking a model anyway is asking
 *   it to invent the day. The Run pipeline ends such a Run as a Quiet Day
 *   before it gets here; this is the guard that holds if a later caller does
 *   not.
 * - Blank prose is never persisted. The model sometimes answers with reasoning
 *   and no message content, which is not an HTTP error and which a naive
 *   pipeline would happily store as an empty Draft. It leaves here as a
 *   retryable failure; the Run is what retries it, on the one attempt budget
 *   that covers both stages.
 */
export class WriteDraft extends Effect.Service<WriteDraft>()("application/drafts/WriteDraft", {
  effect: Effect.gen(function* () {
    const digests = yield* DigestRepository
    const writer = yield* DraftWriter
    const drafts = yield* DraftRepository

    const write = (digest: Parameters<typeof writer.writeDraft>[0]["digest"]) =>
      writer.writeDraft({ digest }).pipe(
        Effect.flatMap((written) =>
          // The easy one to miss: a response that carried reasoning and no
          // message content. Nothing failed on the wire, so this is the only
          // place it can be caught before it becomes an empty Draft.
          isBlank(written.body)
            ? Effect.fail(
                new DraftUnavailable({
                  reason: "The model answered without writing anything.",
                  retryable: true
                })
              )
            : Effect.succeed(written)
        )
      )

    const execute = (request: WriteDraftRequest): Effect.Effect<StoredDraft, DraftUnavailable> =>
      Effect.gen(function* () {
        const existing = yield* drafts.latestForRun(request.runId, request.userId)

        if (Option.isSome(existing)) {
          yield* Effect.logInfo("Run already has a Draft").pipe(
            Effect.annotateLogs({ runId: request.runId, draftId: existing.value.id })
          )
          return existing.value
        }

        const stored = yield* Effect.flatMap(
          digests.findForRun(request.runId, request.userId),
          Option.match({
            onNone: () =>
              Effect.fail(
                new DraftUnavailable({
                  reason: "There is nothing to write from: this Run collected no Digest.",
                  retryable: false
                })
              ),
            onSome: Effect.succeed
          })
        )

        // A day with no Activity at all. Not a failure and not a Draft: there
        // is nothing to write from, and a model handed an empty record writes
        // about a day that did not happen.
        if (stored.digest.isEmpty) {
          return yield* Effect.fail(
            new DraftUnavailable({
              reason: "There was no Activity on this day, so there is nothing to write about.",
              retryable: false
            })
          )
        }

        const written = yield* write(stored.digest)
        const draft = yield* drafts.save(request.runId, request.userId, stored.id, written)

        yield* Effect.logInfo("Wrote a Draft").pipe(
          Effect.annotateLogs({
            runId: request.runId,
            draftId: draft.id,
            digestId: stored.id,
            model: draft.model,
            shape: draft.shape,
            words: wordCount(draft.body),
            totalTokens: draft.totalTokens
          })
        )

        return draft
      })

    return { execute } as const
  })
}) {}
