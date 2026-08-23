import type { SqlClient } from "@effect/sql"
import { Schema } from "effect"
import { Run } from "../../domain/run.ts"

/** One row of `runs`, exactly as Postgres hands it over. */
export interface RunRow {
  readonly id: string
  readonly user_id: string
  readonly repo_connection_id: string | null
  readonly forge: string
  readonly owner: string
  readonly name: string
  readonly day: string
  readonly time_zone: string
  readonly trigger: string
  readonly state: string
  readonly attempts: number
  readonly failure_reason: string | null
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly reasoning_tokens: number | null
  readonly total_tokens: number | null
  /** `numeric` reaches the driver as text, so that six decimal places of a dollar arrive intact. */
  readonly cost_usd: string | null
  readonly requested_at: Date
  readonly started_at: Date | null
  readonly finished_at: Date | null
}

/**
 * The columns of `runs`, spelled out rather than `select *`, for one column's
 * sake: `day` is a calendar day and carries no instant, and a driver that hands
 * it back as a `Date` has already had to invent a timezone to do so. Reading it
 * as text means the three numbers that were written are the three numbers that
 * come back, whatever the machine reading them thinks the time is.
 *
 * `prefix` qualifies the names for statements where `runs` is joined to
 * something that also has an `id`.
 */
export const runColumns = (sql: SqlClient.SqlClient, prefix = "") => {
  const at = (column: string) => sql(`${prefix}${column}`)
  return sql`
    ${at("id")}, ${at("user_id")}, ${at("repo_connection_id")}, ${at("forge")}, ${at("owner")}, ${at("name")},
    to_char(${at("day")}, 'YYYY-MM-DD') as day, ${at("time_zone")}, ${at("trigger")}, ${at("state")},
    ${at("attempts")}, ${at("failure_reason")}, ${at("requested_at")}, ${at("started_at")}, ${at("finished_at")},
    ${at("input_tokens")}, ${at("output_tokens")}, ${at("reasoning_tokens")}, ${at("total_tokens")}, ${at("cost_usd")}
  `
}

/**
 * A Run that has spent nothing carries no cost at all rather than a row of
 * zeroes, so "not written yet" and "cost nothing" stay distinguishable.
 */
const toCost = (row: RunRow) =>
  row.input_tokens === null && row.output_tokens === null && row.total_tokens === null && row.cost_usd === null
    ? null
    : {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        totalTokens: row.total_tokens,
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd)
      }

const decode = Schema.decodeUnknown(Run)

/**
 * Rows that cannot be decoded are defects — the schema and these adapters are
 * written together, so a row that is not a Run means the schema has drifted.
 */
export const toRun = (row: RunRow) =>
  decode({
    id: row.id,
    userId: row.user_id,
    repoConnectionId: row.repo_connection_id,
    repository: { forge: row.forge, owner: row.owner, name: row.name },
    dayWindow: { day: row.day, timeZone: row.time_zone },
    trigger: row.trigger,
    state: row.state,
    attempts: row.attempts,
    failureReason: row.failure_reason,
    cost: toCost(row),
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null
  })
