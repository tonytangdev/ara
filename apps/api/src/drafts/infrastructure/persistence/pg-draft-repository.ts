import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"
import type { UserId } from "../../../connections/domain/user.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import { StoredDraft, type WrittenDraft } from "../../domain/draft.ts"
import { DraftRepository } from "../../domain/ports/draft-repository.ts"

interface DraftRow {
  readonly id: string
  readonly run_id: string
  readonly digest_id: string
  readonly body: string
  readonly model: string
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly total_tokens: number | null
  readonly generated_at: Date
}

const decode = Schema.decodeUnknown(StoredDraft)

/**
 * Rows that cannot be decoded are defects: the schema and this adapter are
 * written together, and a row that is not a Draft means the shape has drifted
 * without a migration.
 */
const toStoredDraft = (row: DraftRow) =>
  decode({
    id: row.id,
    runId: row.run_id,
    digestId: row.digest_id,
    body: row.body,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    generatedAt: row.generated_at.toISOString()
  })

const COLUMNS = "id, run_id, digest_id, body, model, input_tokens, output_tokens, total_tokens, generated_at"

/**
 * Driven (outbound) adapter for Drafts.
 *
 * An insert, never an upsert: a Run accumulates Drafts once regeneration exists
 * (#11), and `latestForRun` is what makes the newest one the one anybody reads.
 *
 * Reading carries `user_id` in the `where` clause, so "a User cannot read
 * another User's Draft" is a property of the SQL rather than a check somebody
 * has to remember to apply.
 */
export const PgDraftRepositoryLive = Layer.effect(
  DraftRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const save = (runId: RunId, userId: UserId, digestId: string, written: WrittenDraft) =>
      sql<DraftRow>`
        insert into drafts (run_id, user_id, digest_id, body, model, input_tokens, output_tokens, total_tokens)
        values (
          ${runId}, ${userId}, ${digestId}, ${written.body}, ${written.model},
          ${written.inputTokens}, ${written.outputTokens}, ${written.totalTokens}
        )
        returning ${sql.unsafe(COLUMNS)}
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.dieMessage("insert of a Draft returned no row") : toStoredDraft(rows[0])
        ),
        Effect.orDie
      )

    const latestForRun = (runId: RunId, userId: UserId) =>
      sql<DraftRow>`
        select ${sql.unsafe(COLUMNS)} from drafts
        where run_id = ${runId} and user_id = ${userId}
        order by generated_at desc, id desc
        limit 1
      `.pipe(
        Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toStoredDraft(rows[0])))),
        Effect.orDie
      )

    return DraftRepository.of({ save, latestForRun })
  })
)
