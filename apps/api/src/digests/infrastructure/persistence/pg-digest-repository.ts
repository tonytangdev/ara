import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"
import type { UserId } from "../../../connections/domain/user.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import { Digest, StoredDigest } from "../../domain/digest.ts"
import { DigestRepository } from "../../domain/ports/digest-repository.ts"

interface DigestRow {
  readonly id: string
  readonly run_id: string
  readonly content: unknown
  readonly collected_at: Date
}

const encodeDigest = Schema.encode(Digest)
const decode = Schema.decodeUnknown(StoredDigest)

/**
 * Rows that cannot be decoded are defects: the schema and this adapter are
 * written together, and a stored document that is not a Digest means the shape
 * has drifted without a migration.
 */
const toStoredDigest = (row: DigestRow) =>
  decode({
    id: row.id,
    runId: row.run_id,
    digest: row.content,
    collectedAt: row.collected_at.toISOString()
  })

/**
 * Driven (outbound) adapter for Digests.
 *
 * Saving is an upsert on `run_id` rather than an insert, because a Run can be
 * claimed more than once: a deploy that interrupts a Run hands it back to the
 * queue, and collecting the same day again has to leave one Digest rather than
 * a second one. `collected_at` moves with the content, so it says when this
 * Digest was read and not when the Run first tried.
 *
 * Reading carries `user_id` in the `where` clause, so "a User cannot read
 * another User's Digest" is a property of the SQL rather than a check somebody
 * has to remember to apply.
 */
export const PgDigestRepositoryLive = Layer.effect(
  DigestRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const save = (runId: RunId, userId: UserId, digest: Digest) =>
      Effect.flatMap(
        encodeDigest(digest),
        (content) =>
          sql<DigestRow>`
            insert into digests (run_id, user_id, content)
            values (${runId}, ${userId}, ${JSON.stringify(content)}::jsonb)
            on conflict (run_id) do update set
              content = excluded.content,
              collected_at = now()
            returning id, run_id, content, collected_at
          `
      ).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.dieMessage("upsert of a Digest returned no row") : toStoredDigest(rows[0])
        ),
        Effect.orDie
      )

    const findForRun = (runId: RunId, userId: UserId) =>
      sql<DigestRow>`
        select id, run_id, content, collected_at from digests
        where run_id = ${runId} and user_id = ${userId}
      `.pipe(
        Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toStoredDigest(rows[0])))),
        Effect.orDie
      )

    return DigestRepository.of({ save, findForRun })
  })
)
