import { SqlClient } from "@effect/sql"
import { DateTime, Effect, Layer, type Option, Schema } from "effect"
import type { UserId } from "../../../connections/domain/user.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import { type DraftCursor, type DraftId, DraftSummary, StoredDraft, type WrittenDraft } from "../../domain/draft.ts"
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
 * One row of the Draft list: the Draft, plus the two things that say which day
 * of which repository it is about.
 */
interface DraftSummaryRow {
  readonly id: string
  readonly run_id: string
  readonly digest_id: string
  readonly forge: string
  readonly owner: string
  readonly name: string
  readonly day: string
  readonly time_zone: string
  readonly is_quiet: boolean
  readonly model: string
  readonly generated_at: Date
}

const decodeSummary = Schema.decodeUnknown(DraftSummary)

const toDraftSummary = (row: DraftSummaryRow) =>
  decodeSummary({
    id: row.id,
    runId: row.run_id,
    digestId: row.digest_id,
    repository: { forge: row.forge, owner: row.owner, name: row.name },
    dayWindow: { day: row.day, timeZone: row.time_zone },
    isQuiet: row.is_quiet,
    model: row.model,
    generatedAt: row.generated_at.toISOString()
  })

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

    const findOwnedBy = (id: DraftId, userId: UserId) =>
      sql<DraftRow>`
        select ${sql.unsafe(COLUMNS)} from drafts
        where id = ${id} and user_id = ${userId}
      `.pipe(
        Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toStoredDraft(rows[0])))),
        Effect.orDie
      )

    /**
     * The list, newest first, keyed off `(generated_at, id)` so a cursor names
     * a position rather than a count. The joins are what turn a Draft into
     * something choosable: the Run says which repository and which Day Window,
     * and the Digest carries the Quiet Day judgement that decides a Draft's
     * shape. Both are inner joins because both rows are guaranteed — a Draft
     * cannot be written without them, and they cascade away together.
     */
    const listFor = (userId: UserId, page: { readonly limit: number; readonly after: Option.Option<DraftCursor> }) => {
      const after =
        page.after._tag === "None"
          ? sql``
          : sql`and (drafts.generated_at, drafts.id) < (${DateTime.toDate(page.after.value.generatedAt)}::timestamptz, ${
              page.after.value.id
            }::uuid)`

      return sql<DraftSummaryRow>`
        select
          drafts.id, drafts.run_id, drafts.digest_id, drafts.model, drafts.generated_at,
          runs.forge, runs.owner, runs.name, to_char(runs.day, 'YYYY-MM-DD') as day, runs.time_zone,
          coalesce((digests.content ->> 'isQuiet')::boolean, false) as is_quiet
        from drafts
        join runs on runs.id = drafts.run_id
        join digests on digests.id = drafts.digest_id
        where drafts.user_id = ${userId} ${after}
        order by drafts.generated_at desc, drafts.id desc
        limit ${page.limit}
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, toDraftSummary)),
        Effect.orDie
      )
    }

    return DraftRepository.of({ save, latestForRun, findOwnedBy, listFor })
  })
)
