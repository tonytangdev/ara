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
  /** Read from the Digest this Draft was written from, never stored beside it. */
  readonly is_quiet: boolean
  readonly body: string
  readonly edited_body: string | null
  readonly edited_at: Date | null
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
    editedBody: row.edited_body,
    editedAt: row.edited_at === null ? null : row.edited_at.toISOString(),
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    generatedAt: row.generated_at.toISOString()
  })

const COLUMNS =
  "id, run_id, digest_id, body, edited_body, edited_at, model, input_tokens, output_tokens, total_tokens, generated_at"

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
  readonly is_edited: boolean
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
    shape: row.is_quiet ? "quiet" : "full",
    isEdited: row.is_edited,
    model: row.model,
    generatedAt: row.generated_at.toISOString()
  })

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

    const findOwnedBy = (id: DraftId, userId: UserId) =>
      sql<DraftRow>`
        select ${sql.unsafe(qualified("drafts"))}, ${sql.unsafe(SHAPE)}
        from drafts join digests on digests.id = drafts.digest_id
        where drafts.id = ${id} and drafts.user_id = ${userId}
      `.pipe(
        Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toStoredDraft(rows[0])))),
        Effect.orDie
      )

    /**
     * The edit lands in its own column, so the generated prose is still there
     * afterwards. `where user_id` is what makes editing somebody else's Draft
     * indistinguishable from editing one that never existed: no row matches, so
     * nothing is returned and nothing is written.
     */
    const saveEdit = (id: DraftId, userId: UserId, body: string) =>
      // One statement, like `save`: the update feeds a select that joins the
      // Digest back, so an edited Draft comes back knowing its own shape.
      sql<DraftRow>`
        with edited as (
          update drafts
          set edited_body = ${body}, edited_at = now()
          where id = ${id} and user_id = ${userId}
          returning ${sql.unsafe(COLUMNS)}
        )
        select ${sql.unsafe(qualified("edited"))}, ${sql.unsafe(SHAPE)}
        from edited join digests on digests.id = edited.digest_id
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
          ${sql.unsafe(SHAPE)},
          drafts.edited_at is not null as is_edited
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

    return DraftRepository.of({ save, latestForRun, findOwnedBy, saveEdit, listFor })
  })
)
