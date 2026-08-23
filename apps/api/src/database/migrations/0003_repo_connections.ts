import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Repo Connections: which repositories a User has entitled Ara to write about.
 *
 * Repository identity is `(forge, owner, name)` (ADR-0003) — three columns, not
 * a parsed `owner/name` string — and a connection is unique per User, so the
 * same repository connected by two people is two independent connections.
 *
 * What is stored against the connection is `installation_external_id`: a
 * reference to the authorization, not a credential. The token that reads the
 * repository is minted from the App's private key when it is needed (ADR-0005),
 * so this table leaking grants nobody any source code.
 *
 * Runs and Drafts, when they arrive, reference a connection with `on delete set
 * null` and keep their own copy of the repository identity: disconnecting a
 * repository stops Ara reading it from then on, and leaves the Drafts the User
 * already generated intact.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(
    Effect.all([
      sql`
        create table repo_connections (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references users (id) on delete cascade,
          forge text not null,
          owner text not null,
          name text not null,
          installation_external_id text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (user_id, forge, owner, name)
        )
      `,
      sql`create index repo_connections_user_id_idx on repo_connections (user_id)`,
      sql`
        create trigger repo_connections_set_updated_at before update on repo_connections
          for each row execute function set_updated_at()
      `
    ])
  )
)
