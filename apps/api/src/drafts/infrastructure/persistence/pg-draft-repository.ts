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
  /** Read from the Digest this Draft was written from, never stored beside it. */
  readonly is_quiet: boolean
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
    shape: row.is_quiet ? "quiet" : "full",
    body: row.body,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    generatedAt: row.generated_at.toISOString()
  })

const COLUMNS = "id, run_id, digest_id, body, model, input_tokens, output_tokens, total_tokens, generated_at"

/**
 * Whether this is a Quiet Draft, taken from the Digest it was written from.
 *
 * Derived rather than stored, because it is not an independent fact: the shape
 * of a Draft follows from `isQuiet`, which was decided when the Digest was built
 * and cannot change afterwards. A column here would be a second copy of that
 * decision, free to drift from the first and to disagree with the Digest a User
 * can read beside it.
 */
const SHAPE = "coalesce((digests.content->>'isQuiet')::boolean, false) as is_quiet"

const qualified = (table: string) =>
  COLUMNS.split(", ")
    .map((column) => `${table}.${column}`)
    .join(", ")

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
      // One statement: the insert feeds a select that joins the Digest back, so
      // a saved Draft comes back knowing its own shape without a second read.
      sql<DraftRow>`
        with written as (
          insert into drafts (run_id, user_id, digest_id, body, model, input_tokens, output_tokens, total_tokens)
          values (
            ${runId}, ${userId}, ${digestId}, ${written.body}, ${written.model},
            ${written.inputTokens}, ${written.outputTokens}, ${written.totalTokens}
          )
          returning ${sql.unsafe(COLUMNS)}
        )
        select ${sql.unsafe(qualified("written"))}, ${sql.unsafe(SHAPE)}
        from written join digests on digests.id = written.digest_id
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.dieMessage("insert of a Draft returned no row") : toStoredDraft(rows[0])
        ),
        Effect.orDie
      )

    const latestForRun = (runId: RunId, userId: UserId) =>
      sql<DraftRow>`
        select ${sql.unsafe(qualified("drafts"))}, ${sql.unsafe(SHAPE)}
        from drafts join digests on digests.id = drafts.digest_id
        where drafts.run_id = ${runId} and drafts.user_id = ${userId}
        order by drafts.generated_at desc, drafts.id desc
        limit 1
      `.pipe(
        Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toStoredDraft(rows[0])))),
        Effect.orDie
      )

    return DraftRepository.of({ save, latestForRun })
  })
)
