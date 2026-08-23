import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Digests: the factual record of one repository's Day Window, persisted between
 * the two stages of a Run (ADR-0002). Storing it is what makes regenerating a
 * Draft cost one model call and no Forge calls, and what makes re-processing an
 * interrupted Run affordable.
 *
 * The Digest itself is one `jsonb` document rather than five normalized tables.
 * It is written whole, read whole, and only ever looked up by the Run that
 * produced it — there is no query that wants "every file Ara has ever seen".
 * Splitting it would buy nothing and would give the shape two definitions, one
 * of them in DDL.
 *
 * `run_id` is unique, which is what makes collecting idempotent: a Run claimed
 * twice upserts its Digest rather than accumulating them. `user_id` is carried
 * so that reading can be scoped to its owner in SQL rather than by a join
 * somebody has to remember to write.
 *
 * Nothing here can hold source code. A Digest carries subjects, paths and line
 * counts, and no diff hunk ever reaches it (ADR-0004) — so this table leaking
 * discloses what a repository's file tree looks like, and never what is in it.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(
    Effect.all([
      sql`
        create table digests (
          id uuid primary key default gen_random_uuid(),
          run_id uuid not null unique references runs (id) on delete cascade,
          user_id uuid not null references users (id) on delete cascade,
          content jsonb not null,
          collected_at timestamptz not null default now(),
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `,
      sql`create index digests_user_id_idx on digests (user_id, collected_at desc)`,
      sql`
        create trigger digests_set_updated_at before update on digests
          for each row execute function set_updated_at()
      `
    ])
  )
)
