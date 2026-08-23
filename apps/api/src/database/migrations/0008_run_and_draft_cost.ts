import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * What a Run and a Draft cost.
 *
 * Two additions, and the reasoning column is the one that earns its keep. Ara
 * writes with a reasoning model, where the tokens spent thinking are most of
 * the bill and are reported by the provider apart from the tokens that became
 * prose. Folding them into `output_tokens` would hide the number that actually
 * moves — so it gets a column, and stays a breakdown of the output rather than
 * an addition to it.
 *
 * `numeric(12, 6)` and not a float: money that is added up across a month of
 * daily Runs should not drift, and six decimal places is what a fraction of a
 * cent needs. Postgres hands `numeric` back as text, which is exactly the
 * property that keeps it intact.
 *
 * Cost is recorded in both places on purpose. A Draft's cost is what that call
 * cost, and it stays true forever. A Run's is what that Run spent, which is the
 * number a User can actually ask for, because the Run id is the one they hold.
 *
 * Every column is nullable. A provider that declines to report usage leaves a
 * Draft with no cost, and losing the Draft over an accounting detail would be
 * the worse trade.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(
    Effect.all([
      sql`
        alter table drafts
          add column reasoning_tokens integer,
          add column cost_usd numeric(12, 6)
      `,
      sql`
        alter table runs
          add column input_tokens integer,
          add column output_tokens integer,
          add column reasoning_tokens integer,
          add column total_tokens integer,
          add column cost_usd numeric(12, 6)
      `
    ])
  )
)
