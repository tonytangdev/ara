import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Runs: one attempt to go from a repository and a Day Window to a Draft, and
 * the queue they are claimed from (ADR-0001).
 *
 * A Run keeps its own copy of `(forge, owner, name)` and references the Repo
 * Connection with `on delete set null`, so disconnecting a repository stops Ara
 * reading it without destroying the Runs a User already asked for.
 *
 * The Day Window is stored three times over on purpose: `day` and `time_zone`
 * are what the User asked for, and `window_starts_at` / `window_ends_at` are
 * the instants that means. A calendar day in Pacific/Auckland is not the UTC
 * day of the same name and is not always 24 hours long, so the boundaries are
 * resolved once, when the Run is requested, rather than re-derived by every
 * reader.
 *
 * Two indexes carry behaviour rather than only speed:
 *
 * - `runs_claimable_idx` is what the worker's `for update skip locked` claim
 *   scans, so claiming stays cheap as finished Runs accumulate.
 * - `runs_in_flight_idx` is a partial unique index over the unfinished states.
 *   It is what makes a double-clicked request return the Run already in flight
 *   instead of paying for a second one, enforced by Postgres rather than by a
 *   check that races.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(
    Effect.all([
      sql`alter table users add column time_zone text not null default 'UTC'`,
      sql`
        create table runs (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references users (id) on delete cascade,
          repo_connection_id uuid references repo_connections (id) on delete set null,
          forge text not null,
          owner text not null,
          name text not null,
          day date not null,
          time_zone text not null,
          window_starts_at timestamptz not null,
          window_ends_at timestamptz not null,
          trigger text not null,
          state text not null default 'queued',
          attempts integer not null default 0,
          failure_reason text,
          requested_at timestamptz not null default now(),
          started_at timestamptz,
          finished_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          constraint runs_state_check check (
            state in ('queued', 'collecting', 'drafting', 'succeeded', 'failed', 'quiet')
          )
        )
      `,
      sql`create index runs_claimable_idx on runs (requested_at) where state = 'queued'`,
      sql`
        create unique index runs_in_flight_idx on runs (user_id, forge, owner, name, day)
          where state in ('queued', 'collecting', 'drafting')
      `,
      sql`create index runs_user_id_idx on runs (user_id, requested_at desc)`,
      sql`
        create trigger runs_set_updated_at before update on runs
          for each row execute function set_updated_at()
      `
    ])
  )
)
