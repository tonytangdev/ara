import { Effect, Layer, Ref } from "effect"
import { PgDigestRepositoryLive } from "../../digests/infrastructure/persistence/pg-digest-repository.ts"
import { WriteDraft } from "../application/write-draft.ts"
import { WrittenDraft } from "../domain/draft.ts"
import { DraftUnavailable, DraftWriter } from "../domain/ports/draft-writer.ts"
import { PgDraftRepositoryLive } from "../infrastructure/persistence/pg-draft-repository.ts"

/** What a fake writer answers with: prose, or a failure the port already knows how to describe. */
export type ScriptedAnswer = { readonly body: string } | { readonly fails: DraftUnavailable }

/** Enough prose for a Run to finish, for the tests that are not about what it wrote. */
export const A_PASSABLE_DRAFT =
  "Spent the day on the collect stage. It reads a day of Activity and turns it into " +
  "something worth writing from, which is less glamorous than it sounds and took longer than it should have."

/**
 * A model that answers from a script instead of over the network.
 *
 * Shared rather than rewritten per test file because several tests need a Run
 * to be able to finish and are not about what it wrote. No application-layer
 * test makes a real model call: Draft quality is not a unit test, and the
 * prototype's blind comparison is the instrument for that question.
 *
 * The script is consumed one answer per call and the last answer repeats, so a
 * test can say "nothing the first time, prose the second" — which is the shape
 * of the failure this whole module is careful about.
 */
export const draftWriterAnswering = (answers: ReadonlyArray<ScriptedAnswer>) =>
  Layer.effect(
    DraftWriter,
    Effect.map(Ref.make(0), (calls) =>
      DraftWriter.of({
        writeDraft: () =>
          Effect.flatMap(
            Ref.updateAndGet(calls, (made) => made + 1),
            (made) => {
              const answer = answers[made - 1] ?? answers.at(-1)

              if (answer === undefined || "fails" in answer) {
                return Effect.fail(
                  answer?.fails ??
                    new DraftUnavailable({ reason: "The fake model ran out of answers.", retryable: false })
                )
              }

              return Effect.succeed(
                new WrittenDraft({
                  body: answer.body,
                  model: "fake/scripted",
                  inputTokens: 1_200,
                  outputTokens: 300,
                  totalTokens: 1_500
                })
              )
            }
          )
      })
    )
  )

/** A model that always writes the same passable post. */
export const draftWriterWriting = (body: string) => draftWriterAnswering([{ body }])

/** The Draft stage, writing from a script and reading and writing a real database. */
export const writeDraftOver = (writer: Layer.Layer<DraftWriter>) =>
  WriteDraft.Default.pipe(Layer.provide(Layer.mergeAll(writer, PgDraftRepositoryLive, PgDigestRepositoryLive)))

/** The Draft stage as the tests that only need a Run to finish want it. */
export const passableDraftStage = writeDraftOver(draftWriterWriting(A_PASSABLE_DRAFT))
