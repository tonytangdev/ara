import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Sign-in: who a person is on a Forge, how they stay signed in, and what Ara
 * holds on their behalf.
 *
 * A User is identified by `(forge, forge_user_id)` rather than by login, so
 * renaming a GitHub account resolves to the same User. Sessions store only a
 * digest of the token handed to the browser, and the Forge credential is
 * stored encrypted (ADR-0005) — installation tokens are minted on demand and
 * never land in a column.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(
    Effect.all([
      sql`
        create table users (
          id uuid primary key default gen_random_uuid(),
          forge text not null,
          forge_user_id text not null,
          login text not null,
          display_name text,
          avatar_url text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (forge, forge_user_id)
        )
      `,
      sql`
        create trigger users_set_updated_at before update on users
          for each row execute function set_updated_at()
      `,
      sql`
        create table sessions (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references users (id) on delete cascade,
          token_digest text not null unique,
          expires_at timestamptz not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `,
      sql`create index sessions_user_id_idx on sessions (user_id)`,
      sql`
        create trigger sessions_set_updated_at before update on sessions
          for each row execute function set_updated_at()
      `,
      sql`
        create table forge_credentials (
          user_id uuid primary key references users (id) on delete cascade,
          forge text not null,
          encrypted_access_token text not null,
          encrypted_refresh_token text,
          access_token_expires_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `,
      sql`
        create trigger forge_credentials_set_updated_at before update on forge_credentials
          for each row execute function set_updated_at()
      `,
      sql`
        create table forge_installations (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references users (id) on delete cascade,
          forge text not null,
          external_id text not null,
          account_login text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (forge, external_id)
        )
      `,
      sql`create index forge_installations_user_id_idx on forge_installations (user_id)`,
      sql`
        create trigger forge_installations_set_updated_at before update on forge_installations
          for each row execute function set_updated_at()
      `
    ])
  )
)
